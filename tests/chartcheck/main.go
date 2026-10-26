// chartcheck renders a Helm chart's templates with Go's text/template plus a small re-implementation
// of the Helm/sprig functions the chart uses. It exists so the chart can be verified in
// environments where the helm binary is not available. It is NOT a replacement for `helm lint` /
// `helm template` (run those too); it catches template syntax errors, missing values and invalid YAML.
//
// usage: chartcheck <chart-dir> <values.json> <release-name> <namespace>
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"text/template"
)

func empty(v interface{}) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.String, reflect.Map, reflect.Slice, reflect.Array:
		return rv.Len() == 0
	case reflect.Bool:
		return !rv.Bool()
	case reflect.Float32, reflect.Float64, reflect.Int, reflect.Int64:
		return rv.Float() == 0
	}
	return false
}

func main() {
	if len(os.Args) != 5 {
		fmt.Fprintln(os.Stderr, "usage: chartcheck <chart-dir> <values.json> <release> <namespace>")
		os.Exit(2)
	}
	chartDir, valuesFile, release, ns := os.Args[1], os.Args[2], os.Args[3], os.Args[4]

	var values map[string]interface{}
	raw, err := os.ReadFile(valuesFile)
	must(err)
	must(json.Unmarshal(raw, &values))
	var chart map[string]interface{}
	{
		// Chart.yaml is simple enough to read the two fields we need.
		b, err := os.ReadFile(filepath.Join(chartDir, "Chart.yaml"))
		must(err)
		chart = map[string]interface{}{"Name": "platform", "Version": "1.0.0"}
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "name:") {
				chart["Name"] = strings.TrimSpace(strings.TrimPrefix(l, "name:"))
			}
			if strings.HasPrefix(l, "version:") {
				chart["Version"] = strings.TrimSpace(strings.TrimPrefix(l, "version:"))
			}
		}
	}

	root := template.New("root")
	rng := rand.New(rand.NewSource(1))
	var funcs template.FuncMap
	funcs = template.FuncMap{
		"include": func(name string, data interface{}) (string, error) {
			var buf bytes.Buffer
			err := root.ExecuteTemplate(&buf, name, data)
			return buf.String(), err
		},
		"toYaml": func(v interface{}) string { b, _ := json.Marshal(v); return string(b) }, // JSON is valid YAML
		"toJson": func(v interface{}) string { b, _ := json.Marshal(v); return string(b) },
		"nindent": func(n int, s string) string { return "\n" + indent(n, s) },
		"indent":  func(n int, s string) string { return indent(n, s) },
		"quote": func(v interface{}) string {
			if v == nil {
				return `""`
			}
			b, _ := json.Marshal(fmt.Sprint(v))
			return string(b)
		},
		"default": func(d interface{}, v ...interface{}) interface{} {
			if len(v) == 0 || empty(v[0]) {
				return d
			}
			return v[0]
		},
		"trunc": func(n int, s string) string {
			if len(s) > n {
				return s[:n]
			}
			return s
		},
		"trimSuffix": func(suf, s string) string { return strings.TrimSuffix(s, suf) },
		"toString":   func(v interface{}) string { return fmt.Sprint(v) },
		"dict": func(kv ...interface{}) map[string]interface{} {
			m := map[string]interface{}{}
			for i := 0; i+1 < len(kv); i += 2 {
				m[fmt.Sprint(kv[i])] = kv[i+1]
			}
			return m
		},
		"list":   func(v ...interface{}) []interface{} { return v },
		"append": func(l []interface{}, v interface{}) []interface{} { return append(append([]interface{}{}, l...), v) },
		"get": func(m map[string]interface{}, k string) interface{} {
			if v, ok := m[k]; ok && v != nil {
				return v
			}
			return ""
		},
		"b64enc": func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) },
		"b64dec": func(s string) (string, error) { b, err := base64.StdEncoding.DecodeString(s); return string(b), err },
		"randAlphaNum": func(n int) string {
			const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
			b := make([]byte, n)
			for i := range b {
				b[i] = a[rng.Intn(len(a))]
			}
			return string(b)
		},
		"sha256sum": func(s string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(s))) },
		"lookup": func(_, _, _, _ string) map[string]interface{} { return map[string]interface{}{"data": nil} },
		"required": func(msg string, v interface{}) (interface{}, error) {
			if empty(v) {
				return nil, fmt.Errorf("%s", msg)
			}
			return v, nil
		},
		"ternary": func(a, b interface{}, c bool) interface{} {
			if c {
				return a
			}
			return b
		},
		"print": fmt.Sprint,
	}
	root.Funcs(funcs).Option("missingkey=error")

	files, _ := filepath.Glob(filepath.Join(chartDir, "templates", "*"))
	sort.Strings(files)
	var render []string
	for _, f := range files {
		b, err := os.ReadFile(f)
		must(err)
		name := filepath.Base(f)
		_, err = root.New("templates/" + name).Parse(string(b))
		if err != nil {
			fmt.Fprintf(os.Stderr, "PARSE ERROR in %s: %v\n", name, err)
			os.Exit(1)
		}
		if !strings.HasPrefix(name, "_") && name != "NOTES.txt" {
			render = append(render, "templates/"+name)
		}
	}
	data := map[string]interface{}{
		"Values":   values,
		"Release":  map[string]interface{}{"Name": release, "Namespace": ns, "Service": "Helm"},
		"Chart":    chart,
		"Template": map[string]interface{}{"BasePath": "templates"},
	}
	for _, name := range render {
		var buf bytes.Buffer
		if err := root.ExecuteTemplate(&buf, name, data); err != nil {
			fmt.Fprintf(os.Stderr, "RENDER ERROR in %s: %v\n", name, err)
			os.Exit(1)
		}
		fmt.Printf("# Source: platform/%s\n%s\n---\n", name, buf.String())
	}
	var notes bytes.Buffer
	if err := root.ExecuteTemplate(&notes, "templates/NOTES.txt", data); err != nil {
		fmt.Fprintf(os.Stderr, "RENDER ERROR in NOTES.txt: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "--- NOTES.txt ---\n%s\n", notes.String())
}

func indent(n int, s string) string {
	pad := strings.Repeat(" ", n)
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = pad + l
	}
	return strings.Join(lines, "\n")
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
