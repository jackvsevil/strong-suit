# Everything starthand/startround/submitround logged 22:25–22:40 UTC on 22 Oct (no request bodies are logged)
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name=("starthand" OR "startround" OR "submitround") AND timestamp>="2026-10-22T22:25:00Z" AND timestamp<="2026-10-22T22:40:00Z"' \
  --project strong-suit --limit 200 --order asc --format 'value(timestamp,severity,resource.labels.service_name,resource.labels.revision_name,httpRequest.status,httpRequest.latency,textPayload,jsonPayload.message)' | cut -c1-260
echo "--- revisions"
for s in starthand startround submitround; do gcloud run revisions list --service $s --region europe-west2 --project strong-suit --limit 4 --format 'value(metadata.name,metadata.creationTimestamp,status.conditions[0].status)' 2>&1 | head -4; done
echo "--- starthand 500s overall since #13"
gcloud logging read 'logName="projects/strong-suit/logs/run.googleapis.com%2Frequests" AND resource.labels.service_name="starthand" AND httpRequest.status>=500 AND timestamp>="2026-10-20T14:21:00Z"' --project strong-suit --limit 50 --format 'value(timestamp,httpRequest.status,httpRequest.latency)'
