#!/usr/bin/env bash
# Seed the dos-box catalog from a local DOS folder (default C:\dosdrive):
# each line below is one item, streamed as a tar into the gateway pod
# (`gateway catalog-put`), which unpacks it onto the boxes volume and stores
# the master copy in Spaces. Re-running replaces items (same slug).
#
#   platform/catalog/seed.sh [source-dir] [slug...]
#
# Needs kubectl access to the cluster (that is the admin credential here).
set -euo pipefail
export MSYS_NO_PATHCONV=1

SRC=${1:-/c/dosdrive}
shift || true
ONLY=" $* "
NS=${NS:-dosbox}

# slug | folder in SRC | title | category | C: folder | program | description
ITEMS='
keen1   | keen1   | Commander Keen 1: Marooned on Mars       | game | KEEN1   | KEEN1.EXE   | Apogee, 1990
keen2   | keen2   | Commander Keen 2: The Earth Explodes     | game | KEEN2   | KEEN2.EXE   | Apogee, 1991
keen3   | keen3   | Commander Keen 3: Keen Must Die!         | game | KEEN3   | KEEN3.EXE   | Apogee, 1991
keen4   | keen4   | Commander Keen 4: Secret of the Oracle   | game | KEEN4   | KEEN4E.EXE  | id Software / Apogee, 1991
keen5   | keen5   | Commander Keen 5: The Armageddon Machine | game | KEEN5   | KEEN5E.EXE  | id Software / Apogee, 1991
keen7   | keen7   | Commander Keen 7 (mod)                   | game | KEEN7   | KEEN7.BAT   | A Keen 4 modification
keen8   | keen8   | Commander Keen 8 (mod)                   | game | KEEN8   | KEEN8.BAT   | A Keen 6 modification
dune2   | Dune2   | Dune II                                  | game | DUNE2   | DUNE2.EXE   | Westwood, 1992
pop     | pop     | Prince of Persia                         | game | POP     | PRINCE.EXE  | Broderbund, 1990
stunts  | stunts  | Stunts                                   | game | STUNTS  | STUNTS.COM  | Broderbund, 1990
warcraft2 | WARII | Warcraft II                              | game | WARII   | WAR2.EXE    | Blizzard, 1995
tcpp    | TCC     | Turbo C++ 3.0                            | dev  | TCC     | TC.EXE      | Borland IDE and compiler, BGI included
tp7     | TP70    | Turbo Pascal 7.0                         | dev  | TP70    | TURBO.EXE   | Borland IDE and compiler
masm611 | masm611 | Microsoft Macro Assembler 6.11           | dev  | MASM611 |             | ML, LINK, NMAKE, CodeView in BIN
qbx     | qbx     | QuickBASIC Extended 7.1 (PDS)            | dev  | QBX     | BIN\QBX.EXE | Microsoft BASIC PDS 7.1
norton5 | norton5 | Norton Commander 5                       | util | NORTON5 | NC.EXE      | File manager
tools   | tools   | DOS tools                                | util | TOOLS   | EDIT.COM    | DEBUG, EDIT, MASM, LINK
'

retry() {
  local n
  for n in 1 2 3 4; do
    "$@" && return 0
    echo "  retry $n" >&2
    sleep $((n * 5))
  done
  return 1
}

put() { # slug folder title category dir run description
  tar -C "$SRC" -cf - "$2" | kubectl -n "$NS" exec -i deploy/dosbox-gateway -- /app/gateway catalog-put \
    --slug "$1" --title "$3" --category "$4" --dir "$5" --run "$6" --description "$7" \
    --source "dosdrive" --license "owner's copy"
}

trim() { local s=$1; s=${s#"${s%%[![:space:]]*}"}; printf '%s' "${s%"${s##*[![:space:]]}"}"; }

while IFS='|' read -r slug folder title category dir run desc; do
  slug=$(trim "$slug")
  [ -z "$slug" ] && continue
  [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $slug "* ]] && continue
  folder=$(trim "$folder")
  if [ ! -d "$SRC/$folder" ]; then
    echo "skip $slug: no $SRC/$folder"
    continue
  fi
  echo "== $slug ($(du -sh "$SRC/$folder" | cut -f1))"
  retry put "$slug" "$folder" "$(trim "$title")" "$(trim "$category")" "$(trim "$dir")" "$(trim "$run")" "$(trim "$desc")"
done <<<"$ITEMS"
