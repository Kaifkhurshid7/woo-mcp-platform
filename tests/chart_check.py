#!/usr/bin/env python3
"""Offline structural check of the Helm chart (use when the `helm` binary is not available).

Renders the chart with tests/chartcheck (Go text/template + minimal Helm functions), then asserts the
requirements of the task on the rendered manifests. Always also run `helm lint` / `helm template` when you can.
"""
import copy, json, os, subprocess, sys, tempfile
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHART = os.path.join(ROOT, "charts", "platform")
BIN = os.environ.get("CHARTCHECK_BIN", "/tmp/chartcheck")


def deep_merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            deep_merge(a[k], v)
        else:
            a[k] = v
    return a


def render(files, overrides=None, release="shop", ns="platform"):
    vals = {}
    for f in files:
        with open(os.path.join(CHART, f)) as fh:
            deep_merge(vals, yaml.safe_load(fh) or {})
    if overrides:
        deep_merge(vals, copy.deepcopy(overrides))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
        json.dump(vals, t)
    p = subprocess.run([BIN, CHART, t.name, release, ns], capture_output=True, text=True)
    os.unlink(t.name)
    if p.returncode != 0:
        print(p.stderr)
        sys.exit(f"render failed for {files}")
    docs = [d for d in yaml.safe_load_all(p.stdout) if d]
    return docs, vals


fails = []
def check(cond, msg):
    if not cond:
        fails.append(msg)
        print("  FAIL", msg)


def by_kind(docs, kind):
    return [d for d in docs if d["kind"] == kind]


def verify(name, files, overrides=None, expect_secret=True):
    print(f"\n== {name}")
    docs, vals = render(files, overrides)
    kinds = {}
    for d in docs:
        kinds[d["kind"]] = kinds.get(d["kind"], 0) + 1
    print("  rendered:", ", ".join(f"{k}x{v}" for k, v in sorted(kinds.items())))
    secret_name = vals["secrets"]["existingSecret"] or "shop-secrets"

    # 1. workloads: probes + resources + pinned images
    workloads = by_kind(docs, "Deployment") + by_kind(docs, "StatefulSet")
    check(len(workloads) == 7, f"expected 7 workloads (mariadb, wordpress, woo-mcp, notes, utils, gateway, dashboard), got {len(workloads)}")
    for w in workloads:
        for c in w["spec"]["template"]["spec"]["containers"]:
            tag = f'{w["metadata"]["name"]}/{c["name"]}'
            check("readinessProbe" in c, f"{tag}: no readinessProbe")
            check("livenessProbe" in c, f"{tag}: no livenessProbe")
            r = c.get("resources", {})
            check(r.get("requests", {}).get("cpu") and r.get("requests", {}).get("memory"), f"{tag}: missing resource requests")
            check(r.get("limits", {}).get("cpu") and r.get("limits", {}).get("memory"), f"{tag}: missing resource limits")
            check(":" in c["image"] and not c["image"].endswith(":latest"), f"{tag}: image must be tagged and not :latest ({c['image']})")
            if vals["global"]["imageRegistry"] and "woo-platform" in c["image"]:
                check(c["image"].startswith(vals["global"]["imageRegistry"]), f"{tag}: registry prefix missing ({c['image']})")

    # 2. hardening of our own Node/nginx workloads
    for w in workloads:
        n = w["metadata"]["name"]
        if any(x in n for x in ("woo-mcp", "notes-mcp", "utils-mcp", "gateway", "dashboard")):
            pod = w["spec"]["template"]["spec"]
            c = pod["containers"][0]
            check(pod["securityContext"].get("runAsNonRoot") is True, f"{n}: not runAsNonRoot")
            check(c["securityContext"].get("allowPrivilegeEscalation") is False, f"{n}: privilege escalation allowed")
            check(c["securityContext"].get("readOnlyRootFilesystem") is True, f"{n}: root fs writable")
            check(c["securityContext"]["capabilities"]["drop"] == ["ALL"], f"{n}: capabilities not dropped")

    # 3. secrets: no value in plain env; everything via secretKeyRef to the right Secret
    secrets = by_kind(docs, "Secret")
    if expect_secret:
        check(len(secrets) == 1, "chart should create exactly one Secret")
        keys = set(secrets[0]["data"].keys())
        need = {"mariadb-root-password", "mariadb-password", "wp-admin-password", "woo-consumer-key", "woo-consumer-secret",
                "woo-mcp-token", "notes-mcp-token", "utils-mcp-token", "gateway-encryption-key", "gateway-admin-password", "llm-api-key"}
        check(need <= keys, f"Secret is missing keys: {need - keys}")
    else:
        check(len(secrets) == 0, "chart must not create a Secret when existingSecret is set")
    referenced = set()
    for w in workloads:
        for c in w["spec"]["template"]["spec"]["containers"]:
            for e in c.get("env", []):
                ref = e.get("valueFrom", {}).get("secretKeyRef")
                if ref:
                    check(ref["name"] == secret_name, f"{c['name']}.{e['name']} references Secret {ref['name']}, expected {secret_name}")
                    referenced.add(ref["key"])
                lname = e["name"].lower()
                if any(s in lname for s in ("password", "token", "secret", "key")) and "value" in e:
                    check(False, f"{c['name']}.{e['name']} carries a literal value")
    if expect_secret:
        check(referenced <= set(secrets[0]["data"].keys()), f"env references keys missing from the Secret: {referenced - set(secrets[0]['data'].keys())}")

    # 4. storage
    pvcs = {d["metadata"]["name"] for d in by_kind(docs, "PersistentVolumeClaim")}
    check({"shop-wordpress", "shop-gateway"} <= pvcs, f"PVCs missing, have {pvcs}")
    sts = by_kind(docs, "StatefulSet")[0]
    check(sts["spec"]["volumeClaimTemplates"][0]["spec"]["resources"]["requests"]["storage"], "mariadb has no persistent volume")
    sc = vals["global"]["storageClass"]
    if sc:
        check(sts["spec"]["volumeClaimTemplates"][0]["spec"].get("storageClassName") == sc, "storageClass not applied to mariadb")
        for p in by_kind(docs, "PersistentVolumeClaim"):
            check(p["spec"].get("storageClassName") == sc, f"storageClass not applied to {p['metadata']['name']}")

    # 5. exposure: only storefront + dashboard/gateway are published
    ings = by_kind(docs, "Ingress")
    check(len(ings) == 2, "expected two Ingress objects")
    hosts = {r["host"] for i in ings for r in i["spec"]["rules"]}
    check(hosts == {vals["domain"]["store"], vals["domain"]["dashboard"]}, f"unexpected ingress hosts {hosts}")
    backends = {p["backend"]["service"]["name"] for i in ings for r in i["spec"]["rules"] for p in r["http"]["paths"]}
    check(backends == {"shop-wordpress", "shop-gateway", "shop-dashboard"}, f"ingress backends should be wordpress/gateway/dashboard only: {backends}")
    for s in by_kind(docs, "Service"):
        check(s["spec"]["type"] == "ClusterIP", f"{s['metadata']['name']} is not ClusterIP")
    paths = {p["path"]: p["backend"]["service"]["name"] for i in ings for r in i["spec"]["rules"] if r["host"] == vals["domain"]["dashboard"] for p in r["http"]["paths"]}
    check(paths == {"/api": "shop-gateway", "/mcp": "shop-gateway", "/": "shop-dashboard"}, f"dashboard paths wrong: {paths}")
    tls = vals["ingress"]["tls"]["enabled"]
    check(all(("tls" in i["spec"]) == tls for i in ings), "TLS block does not match ingress.tls.enabled")
    if tls and vals["ingress"]["tls"]["clusterIssuer"]:
        check(all(i["metadata"]["annotations"].get("cert-manager.io/cluster-issuer") for i in ings), "cert-manager annotation missing")

    # 6. network policy
    nps = by_kind(docs, "NetworkPolicy")
    if vals["networkPolicy"]["enabled"]:
        check(any(n["spec"]["podSelector"] == {} and n["spec"]["policyTypes"] == ["Ingress"] and "ingress" not in n["spec"] for n in nps), "no default-deny ingress policy")
        up = next(n for n in nps if n["metadata"]["name"].endswith("gateway-to-upstreams"))
        check(up["spec"]["ingress"][0]["from"][0]["podSelector"]["matchLabels"]["app.kubernetes.io/name"] == "gateway", "upstreams must only accept the gateway")
    else:
        check(not nps, "NetworkPolicies rendered although disabled")

    # 7. gateway wiring
    cm = by_kind(docs, "ConfigMap")[0]["data"]
    seed = json.loads(cm["SEED_SERVERS"])
    check([s["slug"] for s in seed] == ["woo", "notes", "utils"], f"seed servers wrong: {[s['slug'] for s in seed]}")
    check(seed[0]["url"] == "http://shop-woo-mcp:3000/mcp", f"woo seed url {seed[0]['url']}")
    check(all("token" not in json.dumps(s).lower() or s["credentialEnv"] for s in seed), "seed leaks credentials")
    check(cm["COOKIE_SECURE"] == ("true" if vals["domain"]["scheme"] == "https" else "false"), "COOKIE_SECURE does not follow the scheme")
    check(cm["PUBLIC_URL"] == f'{vals["domain"]["scheme"]}://{vals["domain"]["dashboard"]}{vals["domain"]["port"]}', f"PUBLIC_URL {cm['PUBLIC_URL']}")
    wp = next(w for w in workloads if w["metadata"]["name"] == "shop-wordpress")
    env = {e["name"]: e.get("value") for e in wp["spec"]["template"]["spec"]["containers"][0]["env"]}
    check(env["WP_SITE_URL"] == f'{vals["domain"]["scheme"]}://{vals["domain"]["store"]}{vals["domain"]["port"]}', f"WP_SITE_URL {env['WP_SITE_URL']}")
    check("HTTP_X_FORWARDED_PROTO" in env["WORDPRESS_CONFIG_EXTRA"], "wp-config proxy header mapping missing")
    print("  checked" , len(docs), "manifests")


verify("local (values.yaml + values-local.yaml)", ["values.yaml", "values-local.yaml"])
verify("prod (values-prod.yaml, existing Secret)", ["values.yaml", "values-prod.yaml"], expect_secret=False)
verify("prod with generated Secret + user-supplied LLM key", ["values.yaml", "values-prod.yaml"], {"secrets": {"existingSecret": "", "llmApiKey": "sk-test"}})
verify("ingress-nginx on kind, no network policy", ["values.yaml", "values-local.yaml"], {"ingress": {"className": "nginx"}, "networkPolicy": {"enabled": False}})

print()
if fails:
    sys.exit(f"{len(fails)} check(s) failed")
print("CHART CHECKS PASSED")
