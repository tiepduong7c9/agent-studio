#!/bin/bash
# RPM owns the files under node_modules but not the directories, so an upgrade
# that drops a nested package (e.g. an adapter release that stops bundling its
# own @agentclientprotocol/sdk) leaves the old package's directory tree behind,
# empty. Node's resolver still walks into that nearer node_modules, finds no
# package.json, and fails with ERR_MODULE_NOT_FOUND — the adapter dies on
# spawn. Prune empty directories once the whole transaction (including the old
# package's erase) has finished.
find '/opt/Agent Studio/resources/engine/node_modules' -mindepth 1 -type d -empty -delete 2>/dev/null || true
