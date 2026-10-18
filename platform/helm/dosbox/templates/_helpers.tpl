{{- define "dosbox.labels" -}}
app.kubernetes.io/part-of: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "dosbox.image" -}}
{{ .root.Values.registry }}/{{ .image.repository }}:{{ .image.tag }}
{{- end }}
