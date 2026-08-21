#!/bin/sh
# Starts the facet-studio MCP server with a Node runtime, and with the PATH the
# user actually has.
#
# GUI hosts - Claude Desktop, Cowork - start plugin processes from launchd,
# which has never read the user's shell profile. A version-managed Node (mise,
# nvm, fnm, volta, asdf) lives only on the PATH those profiles set, so a bare
# `node` command finds nothing and the server never starts. The `facet` CLI the
# server shells out to goes missing for exactly the same reason, so recovering
# the PATH here fixes both at once.
#
# One rule governs everything below: nothing may write to stdout. That is the
# MCP protocol channel, and a single stray line from a shell profile corrupts
# the stream before the handshake. Every probe captures its output or sends it
# to stderr.

set -eu

# Everything below sticks to shell builtins - no dirname, no tail, no sed. A
# broken PATH is the condition this script exists to survive, and reaching for
# an external command is how a rescue script dies of the thing it came to fix.

# A literal newline, for trimming the login shell's answer down to its last line.
nl='
'

# The server sits next to this script, so the plugin's install location is
# whatever directory we were run from. That keeps the launcher working when
# CLAUDE_PLUGIN_ROOT is absent, which is the case when it is run by hand.
case "$0" in
    */*) here=$(CDPATH= cd -- "${0%/*}" && pwd) ;;
    *) here=$(CDPATH= cd -- . && pwd) ;;
esac
server="$here/server.mjs"

if [ ! -f "$server" ]; then
    echo "facet-studio: no server bundle at $server" >&2
    exit 127
fi

# Ask the login shell where the user's tools are. The command substitution is
# what makes this safe: a profile that prints a banner has its output captured
# here instead of reaching stdout. Printing a newline first guarantees the PATH
# is the whole of the last line even when a profile left one half-written.
login_path=$("${SHELL:-/bin/sh}" -lc 'printf "\n%s" "$PATH"' 2>/dev/null) || login_path=""
login_path=${login_path##*"$nl"}
if [ -n "$login_path" ]; then
    PATH="$login_path:$PATH"
fi

# Where the version managers put their shims, for the case where the login
# shell told us nothing - a non-interactive profile, or a shell that failed to
# start. Appended, so anything the user's own profile chose still wins.
for dir in \
    "$HOME/.local/share/mise/shims" \
    "$HOME/.asdf/shims" \
    "$HOME/.volta/bin" \
    "$HOME/.bun/bin" \
    "$HOME/.local/bin" \
    /opt/homebrew/bin \
    /usr/local/bin; do
    if [ -d "$dir" ]; then
        PATH="$PATH:$dir"
    fi
done
export PATH

# FACET_NODE is the escape hatch for anyone whose runtime is somewhere no
# amount of probing would guess.
node_bin=${FACET_NODE:-}

if [ -z "$node_bin" ]; then
    node_bin=$(command -v node 2>/dev/null) || node_bin=""
fi

# Last resort: a manager's install root, taking the highest version the glob
# lands on. Unquoted on purpose - these are globs, and a no-match leaves the
# pattern itself, which the -x test then rejects.
if [ -z "$node_bin" ]; then
    for candidate in \
        "$HOME"/.local/share/mise/installs/node/*/bin/node \
        "$HOME"/.nvm/versions/node/*/bin/node \
        "$HOME"/.fnm/node-versions/*/installation/bin/node; do
        if [ -x "$candidate" ]; then
            node_bin=$candidate
        fi
    done
fi

if [ -z "$node_bin" ]; then
    echo "facet-studio: no Node runtime found on PATH or in the usual version-manager locations." >&2
    echo "facet-studio: set FACET_NODE to a node binary to point the plugin at one directly." >&2
    exit 127
fi

exec "$node_bin" "$server" "$@"
