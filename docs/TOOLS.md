# HeLa Nucleus: canonical tools

Server version **3.0.0**. Generated from the ecosystem schema catalog; regenerate with `npm run docs:generate -- --servers` in the ecosystem checkout.

Only names advertised by `tools/list` are listed here. Older aliases in migration examples are not additional tools. Runtime namespace prefixes are optional and do not change these server-local names.

## `execute_command`

Execute commands on remote hosts or locally. Returns a JSON object with 'command', 'exitCode', 'stdout', and 'stderr'. Commands are validated for dangerous patterns. Output is truncated if exceeding size limits. Rate limited per session.

## `terminal_cat`

Restricted to remote SSH targets. Read remote file contents safely; use hela-membrane read_file for local files.

## `terminal_grep`

Search for a pattern in files safely on remote or local hosts.

## `terminal_ls`

List directory contents safely on remote or local hosts. Avoids shell quoting issues.

## `terminal_session_close`

Close and disconnect an active terminal session, releasing its session slot. Accepts a session name (e.g. 'default', 'build'), session key (e.g. 'local-default'), or 'all' to close all active sessions.

## `terminal_session_list`

List all active local and remote terminal sessions, showing session keys, working directories, active environment variables, last activity timestamps, and capacity.

## `transfer_file`

Transfer files between local machine and remote hosts via SFTP, or copy files locally. Supports upload, download, and local copy operations with size limits and validation.
