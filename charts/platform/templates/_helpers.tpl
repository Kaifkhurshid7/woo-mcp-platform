{{/* Release-scoped base name. */}}
{{- define "platform.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/* Name of one component's objects: dict "root" $ "c" "gateway" -> <release>-gateway */}}
{{- define "platform.cname" -}}
{{- printf "%s-%s" (include "platform.fullname" .root) .c -}}
{{- end -}}

{{- define "platform.selector" -}}
app.kubernetes.io/name: {{ .c }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{- define "platform.labels" -}}
{{ include "platform.selector" . }}
app.kubernetes.io/component: {{ .c }}
app.kubernetes.io/part-of: woo-mcp-platform
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{/* Image of a component built from this repo: dict "root" $ "img" .Values.gateway.image */}}
{{- define "platform.image" -}}
{{- $reg := .root.Values.global.imageRegistry -}}
{{- if $reg -}}
{{- printf "%s/%s:%s" (trimSuffix "/" $reg) .img.repository (toString .img.tag) -}}
{{- else -}}
{{- printf "%s:%s" .img.repository (toString .img.tag) -}}
{{- end -}}
{{- end -}}

{{- define "platform.secretName" -}}
{{- default (printf "%s-secrets" (include "platform.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "platform.storeUrl" -}}
{{- printf "%s://%s%s" .Values.domain.scheme .Values.domain.store .Values.domain.port -}}
{{- end -}}

{{- define "platform.dashboardUrl" -}}
{{- printf "%s://%s%s" .Values.domain.scheme .Values.domain.dashboard .Values.domain.port -}}
{{- end -}}

{{- define "platform.pullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}

{{- define "platform.storageClass" -}}
{{- if .Values.global.storageClass }}
storageClassName: {{ .Values.global.storageClass | quote }}
{{- end }}
{{- end -}}

{{/* Reference one key of the platform Secret. dict "root" $ "key" "wp-admin-password" */}}
{{- define "platform.secretRef" -}}
valueFrom:
  secretKeyRef:
    name: {{ include "platform.secretName" .root }}
    key: {{ .key }}
{{- end -}}

{{/* Hardened container defaults for the Node/nginx workloads. */}}
{{- define "platform.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  capabilities:
    drop: ["ALL"]
{{- end -}}
