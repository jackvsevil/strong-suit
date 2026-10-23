# Error-level log lines from startHand, getMe and submitRound since #13 (message text only, trimmed)
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name=("starthand" OR "getme" OR "submitround" OR "startround") AND severity>=ERROR AND timestamp>="2026-10-20T14:21:00Z"' \
  --project strong-suit --limit 50 --format 'value(timestamp,resource.labels.service_name,textPayload,jsonPayload.message)' | cut -c1-220
