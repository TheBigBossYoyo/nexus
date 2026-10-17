#!/usr/bin/env bash
# Makes the copy of this repository that is published: a fresh clone whose whole history has the machine's
# identifiers replaced (the Windows user name in paths, the machine name, the account SIDs), then checked.
# The working repository is not touched: it keeps its own history and hashes.
#
#   bash scripts/publish-clean-history.sh <branch-to-publish> [out-dir]
#
# What is replaced, in every file of every commit and in every commit message:
#   the user name wherever it stands, except in the author's name   -> user
#   the machine name, any case                                        -> desktop-host
#   the machine's account SIDs                                        -> a placeholder domain
#   the owner's own rules, if extra-rules.txt is beside out-dir (or NEXUS_PUBLISH_EXTRA_RULES names a file):
#   git filter-repo replace-text lines, written as regex:<pattern>==><replacement> so that the check can read them
# What is kept on purpose: the author's name and GitHub no-reply address, the names of NEXUS's own AppContainer
# and capability SIDs (derived from a name; the same on every machine).
#
# Only the given branch, main and the tags are kept. It pushes nothing. It ends with a check that none of the
# patterns is left in any blob or message of what is kept, and fails if one is.
set -euo pipefail
branch="${1:?branch to publish}"
src="$(cd "$(dirname "$0")/.." && pwd)"
out="${2:-$src/test-results/publish/nexus}"
user="${NEXUS_PUBLISH_USER:?set NEXUS_PUBLISH_USER to the Windows user name to remove}"
host="${NEXUS_PUBLISH_HOST:?set NEXUS_PUBLISH_HOST to the machine name to remove}"
sid="${NEXUS_PUBLISH_SID:?set NEXUS_PUBLISH_SID to the machine SID prefix to remove (S-1-5-21-a-b-c)}"
keep="${NEXUS_PUBLISH_KEEP_SUFFIX:-}"   # what may follow the user name where it is the author's own name, e.g. " Melki"
extra="${NEXUS_PUBLISH_EXTRA_RULES:-$(dirname "$out")/extra-rules.txt}"

rm -rf "$out"
mkdir -p "$(dirname "$out")"
git clone --quiet --no-local "$src" "$out"
cd "$out"
git checkout --quiet "$branch"
git branch -f main "origin/main" >/dev/null 2>&1 || true

rules="$out/../replace-rules.txt"
lookahead=""
if [ -n "$keep" ]; then lookahead="(?!$keep)"; fi
{
  printf 'regex:(?i)%s%s==>user\n' "$user" "$lookahead"
  printf 'regex:(?i)%s==>desktop-host\n' "$host"
  printf 'regex:%s==>S-1-5-21-1111111111-2222222222-3333333333\n' "$sid"
  if [ -f "$extra" ]; then grep -v '^\s*$' "$extra"; fi
} > "$rules"
git filter-repo --force --quiet --replace-text "$rules" --replace-message "$rules"

# filter-repo turns every branch of the clone's origin into a local branch, so the pruning comes after it.
for b in $(git for-each-ref --format='%(refname:short)' refs/heads | grep -vx "$branch" | grep -vx main); do git branch -D "$b" >/dev/null; done

# The check: nothing of the patterns is left in any blob or message of what is kept. Every blob is read once per
# pattern (git log -G cannot take a lookahead). grep -P refuses some locales (POSIX among them), so C.UTF-8; an
# answer that is not a number is a failure, never a zero.
blobs_matching() {
  git rev-list --objects --all | cut -d' ' -f1 \
    | git cat-file --batch-check='%(objectname) %(objecttype)' | awk '$2=="blob"{print $1}' \
    | git cat-file --batch | LC_ALL=C.UTF-8 grep -a -c -i -P "$1" || true
}
patterns=("$user$lookahead" "$host" "$sid")
if [ -f "$extra" ]; then
  while IFS= read -r line; do
    case "$line" in regex:*) p="${line#regex:}"; patterns+=("${p%%==>*}") ;; esac
  done < "$extra"
fi
fail=0
for pattern in "${patterns[@]}"; do
  blobs=$(blobs_matching "$pattern")
  messages=$(git log --all --oneline -i --perl-regexp --grep="$pattern" 2>/dev/null | wc -l || true)
  tree=$(git grep -I -i -l --perl-regexp "$pattern" -- . 2>/dev/null | wc -l || true)
  echo "left of [$pattern]: lines in any blob $blobs, messages $messages, files in the tree $tree"
  if [ "$blobs" != "0" ] || [ "$tree" != "0" ] || [ "$messages" != "0" ]; then fail=1; fi
  case "$blobs" in ''|*[!0-9]*) echo "the blob check did not run for [$pattern]"; fail=1 ;; esac
done
echo "branches: $(git branch --format='%(refname:short)' | tr '\n' ' ')"
echo "commits: $(git rev-list --all --count)  tags: $(git tag | wc -l)  head: $(git log --oneline -1 | cut -c1-60)"
exit $fail
