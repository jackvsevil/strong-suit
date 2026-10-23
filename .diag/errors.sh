echo "500s on any function since 20 Oct 14:21 UTC, by minute:"
gcloud logging read 'logName="projects/strong-suit/logs/run.googleapis.com%2Frequests" AND httpRequest.status>=500 AND timestamp>="2026-10-20T14:21:00Z"' --project strong-suit --limit 200 --format 'value(timestamp,resource.labels.service_name)' | awk '{print substr($1,1,16), $2}' | sort | uniq -c
