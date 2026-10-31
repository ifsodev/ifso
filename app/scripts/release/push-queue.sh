#!/usr/bin/env bash
# Ships the local queue branch (the 72 unreleased updates) to the server's bare queue repo, over ssh, from the Mac. The queue never
# goes to GitHub. Pushes to a NEW branch name each time you pass one; the server's runner follows `tu-queue` (see README, "Rebuilt queue").
#   SERVER=root@<ip> bash push-queue.sh [branch-on-server]        run from the backend checkout that holds the local `tu-queue`
# The server's queue repo is owned by the release user: git needs safe.directory on the receiving side, and the pushed objects are
# handed back to the release user afterwards.
set -euo pipefail
: "${SERVER:?usage: SERVER=root@<ip> bash push-queue.sh [branch-on-server]}"
LOCAL_BRANCH="${LOCAL_BRANCH:-tu-queue}"
REMOTE_BRANCH="${1:-tu-queue}"
QUEUE_DIR="${QUEUE_DIR:-/var/lib/ifso-release/queue.git}"
RUSER="${RUSER:-ifso-release}"
git rev-parse --verify -q "$LOCAL_BRANCH" >/dev/null || { echo "no local branch $LOCAL_BRANCH" >&2; exit 1; }
echo "pushing $LOCAL_BRANCH ($(git rev-parse --short "$LOCAL_BRANCH"), $(git rev-list --count "$LOCAL_BRANCH") commits) to $SERVER:$QUEUE_DIR as $REMOTE_BRANCH"
git push --receive-pack="git -c safe.directory='*' receive-pack" "$SERVER:$QUEUE_DIR" "$LOCAL_BRANCH:refs/heads/$REMOTE_BRANCH"
# shellcheck disable=SC2029  # the variables are meant to expand on this side
ssh "$SERVER" "chown -R $RUSER:$RUSER '$QUEUE_DIR'"
echo "done. Next on the server: replace schedule.json from this queue (release.py make-schedule or remap), then sudo ifso-release-preflight."
