#!/usr/bin/env bash
# The session launcher's real run (session launcher design 0.2.4 § 10; plan 0.2.2 § 8; LOCAL-AGENTS-21). Grades the
# clauses no unit test can: AC-1 (the service is running within 10 s and, within 30 s more, the agent's one session is
# live; a re-install restarts the daemon), AC-22 (exactly one tmux session cmdr_<crew>_<handle> running claude with no
# key in `ps`, and the agent answers a mention), AC-23 (the session killed: started fresh within 30 s), AC-25 (stop holds,
# start resumes), AC-27 (the service stopped: no claude of the agent left), AC-7 (optional: a revoked key waits, once).
#
# Run it on a machine with tmux >= 2.0, claude and bun, in a shell holding the agent's three variables (the connect
# snippet's: CMDR_API_URL, CMDR_AGENT_KEY, CMDR_STATE_DIR), with no other session of the agent open. It prints every
# observation with its time and ends PASS, or FAIL <clauses>. Paste its whole output into the pull request. It never
# prints the key.
#
#   bash scripts/launcher-e2e.sh <channel id C for the test> [--skip-revoke]
#
# Steps needing a person are announced: "POST NOW <time>" (post a message naming the agent in C, as one of the crew's
# people) and "REVOKE NOW" (revoke this key on the agent's settings page).
set -u
C="${1:?usage: launcher-e2e.sh <channel id> [--skip-revoke]}"
SKIP_REVOKE="${2:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CLI=(bun "$HERE/cli/cmdr-agent.ts")
: "${CMDR_API_URL:?set CMDR_API_URL}" "${CMDR_AGENT_KEY:?set CMDR_AGENT_KEY}" "${CMDR_STATE_DIR:?set CMDR_STATE_DIR}"
HOME_DIR="$(dirname "$(dirname "${CMDR_STATE_DIR/#\~/$HOME}")")"
KEYPART="${CMDR_AGENT_KEY:8:16}"
FAILED=()
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { say "FAIL $1: $2"; FAILED+=("$1"); }
nokey() { if grep -qF -- "$KEYPART" <<<"$1"; then echo "[redacted: the key appeared here]"; else printf '%s' "$1"; fi; }
os="$(uname -s)"
pid_of() { if [ "$os" = Darwin ]; then launchctl print "gui/$(id -u)/$1" 2>/dev/null | awk '/^\tpid = /{print $3}'; else systemctl --user show -p MainPID --value "$1.service"; fi; }
restarts_of() { if [ "$os" = Darwin ]; then launchctl print "gui/$(id -u)/$1" 2>/dev/null | awk '/^\truns = /{print $3}'; else systemctl --user show -p NRestarts --value "$1.service"; fi; }
active() { if [ "$os" = Darwin ]; then launchctl print "gui/$(id -u)/$1" 2>/dev/null | grep -q 'state = running'; else [ "$(systemctl --user is-active "$1.service")" = active ]; fi; }
wait_for() { local secs="$1"; shift; for i in $(seq 1 "$secs"); do if "$@"; then echo "$i"; return 0; fi; sleep 1; done; return 1; }
up() { tmux has-session -t "=$NAME" 2>/dev/null; }
down() { ! up; }
pane_pid() { tmux list-panes -t "=$NAME" -F '#{pane_pid}' 2>/dev/null | head -1; }

say "platform $os $(uname -r); $(tmux -V); claude $(claude --version 2>/dev/null | head -1); bun $(bun --version)"
say "home $HOME_DIR"
ME="$("${CLI[@]}" me)"
HANDLE="$(sed -n 's/.*"handle": *"\([^"]*\)".*/\1/p' <<<"$ME" | head -1)"
CREW="$(sed -n 's/.*"crewKey": *"\([^"]*\)".*/\1/p' <<<"$ME" | head -1)"
AGENT_NAME="$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' <<<"$ME" | head -1)"
NAME="cmdr_${CREW}_${HANDLE}"
say "agent @$HANDLE of $CREW; its session: $NAME"

# ── AC-1, AC-22 ──
"${CLI[@]}" launch install | while read -r l; do say "install: $(nokey "$l")"; done
if [ "$os" = Darwin ]; then UNIT="it.cmdr.agent.$CREW.$HANDLE"; UFILE="$HOME/Library/LaunchAgents/$UNIT.plist"; else UNIT="cmdr-agent-$CREW-$HANDLE"; UFILE="$HOME/.config/systemd/user/$UNIT.service"; fi
say "unit $UNIT"; say "unit file:"; nokey "$(cat "$UFILE")"; echo
if s="$(wait_for 10 active "$UNIT")"; then say "AC-1 service active after ${s}s"; else fail AC-1 "the service was not active within 10 s"; fi
if s="$(wait_for 30 up)"; then say "AC-1/AC-22 $NAME up after ${s}s more"; else fail AC-22 "no tmux session $NAME within 30 s"; fi
n="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c "^cmdr_${CREW}_${HANDLE}\$")"; say "AC-22 tmux sessions named $NAME: $n"
[ "$n" = 1 ] || fail AC-22 "expected exactly one $NAME, saw $n"
pane="$(tmux list-panes -t "=$NAME" -F '#{pane_current_command}' 2>/dev/null | head -1)"; say "AC-22 pane runs: $pane"
case "$pane" in claude*|node*) ;; *) fail AC-22 "the pane's process is not claude ($pane)";; esac
grep -qF -- "$KEYPART" <<<"$(ps -eo args)" && fail AC-16 "the key is in ps output"
if s="$(wait_for 30 bash -c "${CLI[*]} sessions | grep -q '^main'")"; then say "AC-22 sessions lists main after ${s}s"; else fail AC-22 "cmdr-agent sessions listed no main session within 30 s"; fi
p1="$(pid_of "$UNIT")"; "${CLI[@]}" launch install >/dev/null; sleep 3; p2="$(pid_of "$UNIT")"
say "AC-1 daemon pid before $p1, after a second install $p2"
{ [ -n "$p1" ] && [ -n "$p2" ] && [ "$p1" != 0 ] && [ "$p2" != 0 ] && [ "$p1" != "$p2" ]; } || fail AC-1 "a second install did not restart the daemon (pids $p1 → $p2)"
for f in agent.key config.json; do say "mode $f $(stat -c '%a' "$HOME_DIR/launcher/$f" 2>/dev/null || stat -f '%Lp' "$HOME_DIR/launcher/$f")"; done
wait_for 30 up >/dev/null || fail AC-1 "no session after the re-install"

BEFORE="$("${CLI[@]}" history "$C" --limit 20 | grep -cF "] $AGENT_NAME:")"
say "POST NOW $(date -u +%FT%TZ): a message naming @$HANDLE in $C, as one of the crew's people"
ok=""; for i in $(seq 1 60); do now="$("${CLI[@]}" history "$C" --limit 20 | grep -cF "] $AGENT_NAME:")"; if [ "$now" -gt "$BEFORE" ]; then ok=1; break; fi; sleep 5; done
[ -n "$ok" ] && say "AC-22 the agent answered in $C" || fail AC-22 "no answer by the agent in $C within 300 s"
n="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c "^cmdr_")"; say "AC-22 cmdr tmux sessions after the mention: $n (no per-conversation session)"

# ── AC-23: killed, started fresh ──
sleep 61 # past the 60 s early-exit line, so no backoff
kill "$(pane_pid)" 2>/dev/null; tmux kill-session -t "=$NAME" 2>/dev/null
if s="$(wait_for 45 up)"; then say "AC-23 started fresh ${s}s after it ended"; else fail AC-23 "not started again within 45 s"; fi

# ── AC-25: stop holds, start resumes ──
"${CLI[@]}" launch stop | while read -r l; do say "stop: $l"; done
sleep 95
if down; then say "AC-25 still stopped after 3 ticks"; else fail AC-25 "a session started while stopped"; fi
"${CLI[@]}" launch start | while read -r l; do say "start: $l"; done
if s="$(wait_for 45 up)"; then say "AC-25 started ${s}s after start"; else fail AC-25 "not started within 45 s of start"; fi

say "events.log:"; nokey "$(cat "$HOME_DIR/launcher/events.log")"; echo
grep -qF -- "$KEYPART" "$HOME_DIR/launcher/events.log" "$HOME_DIR/launcher/config.json" "$HOME_DIR/launcher/state.json" "$UFILE" && fail AC-10 "the key is in a file of the home or the unit"

# ── AC-7 (optional) ──
if [ "$SKIP_REVOKE" != --skip-revoke ]; then
  r1="$(restarts_of "$UNIT")"; pa="$(pid_of "$UNIT")"
  say "REVOKE NOW: revoke this key on the agent's settings page; the session will be cut off (waiting 6 minutes)"; sleep 360
  r2="$(restarts_of "$UNIT")"; pb="$(pid_of "$UNIT")"
  say "AC-7 restarts $r1 → $r2, pid $pa → $pb"
  [ "$r1" = "$r2" ] && [ "$pa" = "$pb" ] || fail AC-7 "the daemon restarted while refused"
  n="$(grep -c 'launcher.refused reason=unauthorized' "$HOME_DIR/launcher/events.log")"; say "AC-7 launcher.refused lines: $n"
  [ "$n" = 1 ] || fail AC-7 "expected exactly one launcher.refused reason=unauthorized, saw $n"
fi

"${CLI[@]}" launch status | while read -r l; do say "status: $l"; done

# ── AC-27: the session dies with its supervisor ──
if [ "$os" = Darwin ]; then launchctl bootout "gui/$(id -u)/$UNIT"; else systemctl --user stop "$UNIT.service"; fi
sleep 5
if down; then say "AC-27 no $NAME after the service stopped"; else fail AC-27 "$NAME outlived the service"; fi
say "to resume: cmdr-agent launch install (or start the service again)"

if [ ${#FAILED[@]} -eq 0 ]; then say PASS; else say "FAIL ${FAILED[*]}"; exit 1; fi
