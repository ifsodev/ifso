#!/usr/bin/env bash
# Ships a local queue branch (the unreleased updates) to the server's bare queue repo, over ssh, from the Mac. The queue never
# goes to GitHub. Never forced, never overwrites a branch that exists on the server:
#   SERVER=root@<ip> bash push-queue.sh                       first time: the local tu-queue becomes the server's tu-queue
#   SERVER=root@<ip> LOCAL_BRANCH=queue-r1 bash push-queue.sh queue-r1
#                                                             a REBUILT queue (after an owner fix): to a NEW branch name; then
#                                                             remap and move tu-queue ON THE SERVER (README, "Rebuilt queue")
# Run from the backend checkout that holds the local branch. The server's queue repo is owned by the release user: git needs
# safe.directory on the receiving side, and the pushed objects are handed back to the release user afterwards.
# Test knobs (sandbox only): QUEUE_URL=<path> instead of $SERVER:$QUEUE_DIR, SKIP_CHOWN=1.
set -euo pipefail
QUEUE_DIR="${QUEUE_DIR:-/var/lib/ifso-release/queue.git}"
RUSER="${RUSER:-ifso-release}"
if [[ -z "${QUEUE_URL:-}" ]]; then
  : "${SERVER:?usage: SERVER=root@<ip> [LOCAL_BRANCH=<local>] bash push-queue.sh [new-branch-on-server]}"
  QUEUE_URL="$SERVER:$QUEUE_DIR"
fi
LOCAL_BRANCH="${LOCAL_BRANCH:-tu-queue}"
REMOTE_BRANCH="${1:-}"
die() { echo "push-queue.sh: $*" >&2; exit 1; }
git rev-parse --verify -q "$LOCAL_BRANCH" >/dev/null || die "no local branch $LOCAL_BRANCH"
[[ -z "$REMOTE_BRANCH" || "$REMOTE_BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$ ]] || die "bad branch name '$REMOTE_BRANCH'"
UP=(--upload-pack="git -c safe.directory='*' upload-pack")
on_server() { git ls-remote "${UP[@]}" --heads "$QUEUE_URL" "refs/heads/$1" | grep -q .; }
if on_server tu-queue; then
  [[ -n "$REMOTE_BRANCH" && "$REMOTE_BRANCH" != tu-queue ]] \
    || die "tu-queue already exists on the server and is never overwritten: push the rebuilt queue to a NEW branch, e.g. LOCAL_BRANCH=$LOCAL_BRANCH bash push-queue.sh queue-r1, then remap and move tu-queue on the server (README, 'Rebuilt queue')"
else
  REMOTE_BRANCH="${REMOTE_BRANCH:-tu-queue}"
fi
on_server "$REMOTE_BRANCH" && die "$REMOTE_BRANCH already exists on the server: pick a new name (a pushed queue is never overwritten)"
echo "pushing $LOCAL_BRANCH ($(git rev-parse --short "$LOCAL_BRANCH"), $(git rev-list --count "$LOCAL_BRANCH") commits) to $QUEUE_URL as $REMOTE_BRANCH"
git push --receive-pack="git -c safe.directory='*' receive-pack" "$QUEUE_URL" "$LOCAL_BRANCH:refs/heads/$REMOTE_BRANCH"
if [[ "${SKIP_CHOWN:-0}" != 1 ]]; then
  # shellcheck disable=SC2029  # the variables are meant to expand on this side
  ssh "$SERVER" "chown -R $RUSER:$RUSER '$QUEUE_DIR'"
fi
if [[ "$REMOTE_BRANCH" == tu-queue ]]; then
  echo "done. Next on the server: release.py make-schedule (README, 'Install on the server'), then sudo ifso-release-preflight."
else
  echo "done. Next on the server: release.py remap --ref $REMOTE_BRANCH, then update-ref tu-queue to it, then sudo ifso-release-preflight (README, 'Rebuilt queue')."
fi
