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
# What is kept on purpose: the author's name and GitHub no-reply address, the names of NEXUS's own AppContainer
# and capability SIDs (derived from a name; the same on every machine).
#
# It pushes nothing. It ends with a check that none of the identifiers is left in any commit, and fails if one is.
set -euo pipefail
branch="${1:?branch to publish}"
src="$(cd "$(dirname "$0")/.." && pwd)"
out="${2:-$src/test-results/publish/nexus}"
user="${NEXUS_PUBLISH_USER:?set NEXUS_PUBLISH_USER to the Windows user name to remove}"
host="${NEXUS_PUBLISH_HOST:?set NEXUS_PUBLISH_HOST to the machine name to remove}"
sid="${NEXUS_PUBLISH_SID:?set NEXUS_PUBLISH_SID to the machine SID prefix to remove (S-1-5-21-a-b-c)}"
keep="${NEXUS_PUBLISH_KEEP_SUFFIX:-}"   # what may follow the user name where it is the author's own name, e.g. " Melki"

rm -rf "$out"
mkdir -p "$(dirname "$out")"
git clone --quiet --no-local "$src" "$out"
cd "$out"
# Every tag, and the one branch that is published.
git checkout --quiet "$branch"
for b in $(git for-each-ref --format='%(refname:short)' refs/heads | grep -vx "$branch" | grep -vx main); do git branch -D "$b" >/dev/null; done
git branch -f main "origin/main" >/dev/null 2>&1 || true

rules="$out/../replace-rules.txt"
lookahead=""
if [ -n "$keep" ]; then lookahead="(?!$keep)"; fi
{
  printf 'regex:(?i)%s%s==>user\n' "$user" "$lookahead"
  printf 'regex:(?i)%s==>desktop-host\n' "$host"
  printf 'regex:%s==>S-1-5-21-1111111111-2222222222-3333333333\n' "$sid"
} > "$rules"
git filter-repo --force --quiet --replace-text "$rules" --replace-message "$rules"

# The check: nothing of the three is left in any blob or message of any commit that is published.
fail=0
for pattern in "$user$lookahead" "$host" "$sid"; do
  blobs=$(git log --all --oneline -G"$pattern" --regexp-ignore-case --pickaxe-regex 2>/dev/null | wc -l || true)
  messages=$(git log --all --oneline -i --perl-regexp --grep="$pattern" 2>/dev/null | wc -l || true)
  tree=$(git grep -I -i -l --perl-regexp "$pattern" -- . 2>/dev/null | wc -l || true)
  echo "left of [$pattern]: commits touching it $blobs, messages $messages, files in the tree $tree"
  if [ "$tree" != "0" ] || [ "$messages" != "0" ]; then fail=1; fi
done
echo "commits: $(git rev-list --all --count)  tags: $(git tag | wc -l)  head: $(git log --oneline -1 | cut -c1-60)"
exit $fail
