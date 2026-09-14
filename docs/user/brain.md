# Move your Brain to Cloud

In **Brain**, select the local Brain you want to move, then choose **Connect cloud**.
Enter your team's Cloud URL and app access token. The dialog names the Brain being moved;
other local Brains stay separate. Cloud must support Brain transfers.

Flow transfers its Auto-Docs, Auto-Skills, conversation notes, revisions, and supporting
evidence. Existing Cloud documents are preserved. Repositories already configured in Cloud
are reused; missing repositories are queued for indexing. Cloud needs GitHub access to read
private repositories. Local-only repositories must be pushed to GitHub before Cloud can index
them. The local knowledge graph is rebuilt from repositories rather than copied.

The Brain page shows transfer progress and offers **Retry transfer** on failure. Restarting
Flow resumes a pending transfer. Conversation activity arriving during the move is queued
until Cloud confirms the transfer. Brain tools become available again after the move completes.
Local conversation history is retained, and new conversation activity continues to be curated
locally. Updated notes, docs, and skills synchronize to Cloud. Transfers currently support snapshots up to
256 MB; larger snapshots report an error and leave local data intact.

Afterward, every project attached to that Brain uses the shared Cloud knowledge. The app's
Brain page displays Cloud documents, repository indexing progress, and errors. An offline
Cloud Brain is shown as unavailable; Flow does not silently switch back to local knowledge.

With no local Brain selected, **Connect cloud** joins an existing Cloud Brain without importing
local data. Cloud administration and repository access are configured in its dashboard.
