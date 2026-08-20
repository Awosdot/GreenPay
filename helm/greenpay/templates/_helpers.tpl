{{/*
Name of the Secret the workloads read their credentials from.

When .Values.secrets.existingSecret is set the chart renders no Secret of its
own and every workload references the operator-managed one instead — this is
how mainnet keeps production credentials out of the values files.
*/}}
{{- define "greenpay.secretName" -}}
{{- default "greenpay-secrets" .Values.secrets.existingSecret -}}
{{- end -}}

{{/*
Scheme the release is publicly reachable on. Ingress TLS is off in the testnet
defaults and on in the mainnet overlay, and ALLOWED_ORIGINS has to agree with
whichever is actually served or the browser CORS check fails.
*/}}
{{- define "greenpay.publicScheme" -}}
{{- if .Values.ingress.tls.enabled -}}https{{- else -}}http{{- end -}}
{{- end -}}
