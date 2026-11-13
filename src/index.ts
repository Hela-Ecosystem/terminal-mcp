#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { 
  CommandExecutor, 
  CommandExecutionError, 
  TimeoutError, 
  SshConnectionError,
  ValidationError,
  SecurityError,
  ResourceLimitError,
  RateLimitError
} from "./executor.js";
import { log } from "./logger.js";
import { textResult } from "./envelope.js";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const commandExecutor = new CommandExecutor();
const execFileAsync = promisify(execFile);
const rtkBinaries = [
  process.env.RTK_BIN,
  "rtk"
].filter((v): v is string => Boolean(v));

let cachedRtkBinary: string | null | undefined = undefined;

async function getRtkBinary(): Promise<string | null> {
  if (cachedRtkBinary !== undefined) {
    return cachedRtkBinary;
  }

  for (const bin of rtkBinaries) {
    try {
      await execFileAsync(bin, ["--version"], { timeout: 1000 });
      cachedRtkBinary = bin;
      return bin;
    } catch {
      // not available
    }
  }

  cachedRtkBinary = null;
  return null;
}

async function rewriteWithRtk(command: string): Promise<string> {
  if (process.env.RTK_MCP_REWRITE === "false") {
    return command;
  }

  const bin = await getRtkBinary();
  if (!bin) return command;

  try {
    const { stdout } = await execFileAsync(bin, ["rewrite", command], {
      timeout: 1500,
      maxBuffer: 64 * 1024,
      env: process.env
    });
    return stdout.trim() || command;
  } catch {
    return command;
  }
}

async function summarizeWithRtk(text: string, type: 'stdout' | 'stderr'): Promise<{ content: string; summarized: boolean }> {
  if (!text || text.length < 10000) {
    return { content: text, summarized: false };
  }

  const bin = await getRtkBinary();
  if (!bin) {
    return { content: text, summarized: false };
  }

  const tmpFile = path.join(os.tmpdir(), `mcp-rtk-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  
  try {
    fs.writeFileSync(tmpFile, text);
    
    // Use 'smart' for generic output or 'log' if it looks like logs
    const subcommand = type === 'stderr' || text.includes('Error') || text.includes('warning') ? 'log' : 'smart';
    
    return new Promise((resolve) => {
      execFile(bin, [subcommand, tmpFile], {
        timeout: 3000,
        env: process.env
      }, (error, stdout) => {
        // Cleanup temp file
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

        if (error || !stdout.trim()) {
          resolve({ content: text, summarized: false });
        } else {
          const summary = `[RTK ${type.toUpperCase()} SUMMARY]\n${stdout.trim()}\n[Original length: ${text.length} chars]`;
          resolve({ content: summary, summarized: true });
        }
      });
    });
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return { content: text, summarized: false };
  }
}

// Create server
function createServer() {
  const server = new Server(
    {
      name: "terminal-mcp-server",
      version: "3.0.1",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "execute_command",
          description: "Execute commands on remote hosts or locally. Returns a JSON object with 'command', 'exitCode', 'stdout', and 'stderr'. Commands are validated for dangerous patterns. Output is truncated if exceeding size limits. Rate limited per session.",
          inputSchema: {
            type: "object",
            properties: {
              host: {
                type: "string",
                description: "Host to connect to (optional, if not provided the command will be executed locally)"
              },
              username: {
                type: "string",
                description: "Username for SSH connection (required when host is specified)"
              },
              session: {
                type: "string",
                description: "Session name (1-64 alphanumeric chars, underscores, hyphens). Defaults to 'default'. Reuse to persist state.",
                default: "default"
              },
              command: {
                type: "string",
                description: "Command to execute. Validated for dangerous patterns unless ENABLE_COMMAND_VALIDATION=false."
              },
              env: {
                type: "object",
                description: "Environment variables to set.",
                default: {}
              },
              workingDirectory: {
                type: "string",
                description: "Working directory for command execution. Validated to exist for local commands."
              },
              timeout: {
                type: "number",
                description: "Command timeout in milliseconds (default: 30000, max: 600000)",
                default: 30000
              },
              useRtk: {
                type: "boolean",
                description: "Whether to apply RTK token optimization and rewriting (default: true). Set to false for interactive commands or sudo.",
                default: true
              }
            },
            required: ["command"]
          }
        },
        {
          name: "transfer_file",
          description: "Transfer files between local machine and remote hosts via SFTP, or copy files locally. Supports upload, download, and local copy operations with size limits and validation.",
          inputSchema: {
            type: "object",
            properties: {
              source: {
                type: "string",
                description: "Source file path. For uploads: local path. For downloads: remote path. For local copy: source path."
              },
              destination: {
                type: "string",
                description: "Destination file path. For uploads: remote path. For downloads: local path. For local copy: destination path."
              },
              direction: {
                type: "string",
                enum: ["upload", "download", "local"],
                description: "Transfer direction: 'upload' (local to remote), 'download' (remote to local), or 'local' (local copy)"
              },
              host: {
                type: "string",
                description: "Remote host (required for upload/download, omit for local copy)"
              },
              username: {
                type: "string",
                description: "Username for SSH connection (required for upload/download)"
              },
              session: {
                type: "string",
                description: "Session name for connection reuse (default: 'default')",
                default: "default"
              },
              overwrite: {
                type: "boolean",
                description: "Overwrite destination if it exists (default: false)",
                default: false
              }
            },
            required: ["source", "destination", "direction"]
          }
        },
        {
          name: "terminal_ls",
          description: "List directory contents safely on remote or local hosts. Avoids shell quoting issues.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to list" },
              host: { type: "string", description: "Remote host (optional)" },
              username: { type: "string", description: "Username for SSH (required if host provided)" },
              session: { type: "string", default: "default" },
              all: { type: "boolean", description: "Show hidden files (like -a)", default: true },
              long: { type: "boolean", description: "Use long listing format (like -l)", default: true },
              useRtk: { type: "boolean", description: "Use RTK optimization (default: true)", default: true }
            },
            required: ["path"]
          }
        },
        {
          name: "terminal_grep",
          description: "Search for a pattern in files safely on remote or local hosts.",
          inputSchema: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Search pattern" },
              path: { type: "string", description: "File or directory path" },
              host: { type: "string", description: "Remote host (optional)" },
              username: { type: "string", description: "Username for SSH (required if host provided)" },
              session: { type: "string", default: "default" },
              recursive: { type: "boolean", description: "Search recursively (like -r)", default: true },
              ignoreCase: { type: "boolean", description: "Ignore case (like -i)", default: false },
              lineNumber: { type: "boolean", description: "Show line numbers (like -n)", default: true },
              useRtk: { type: "boolean", description: "Use RTK optimization (default: true)", default: true }
            },
            required: ["pattern", "path"]
          }
        },
        {
          name: "terminal_cat",
          description: "Restricted to remote SSH targets. Read remote file contents safely; use hela-membrane read_file for local files.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to read" },
              host: { type: "string", description: "Remote host (required; local reads must use hela-membrane read_file)" },
              username: { type: "string", description: "Username for SSH (required if host provided)" },
              session: { type: "string", default: "default" },
              tail: { type: "boolean", description: "If true, reads the end of the file (like tail)", default: false },
              lines: { type: "number", description: "Number of lines to read if using tail (like -n)", default: 100 },
              useRtk: { type: "boolean", description: "Use RTK optimization (default: true)", default: true }
            },
            required: ["path", "host"]
          }
        },
        {
          name: "terminal_session_close",
          description: "Close and disconnect an active terminal session, releasing its session slot. Accepts a session name (e.g. 'default', 'build'), session key (e.g. 'local-default'), or 'all' to close all active sessions.",
          inputSchema: {
            type: "object",
            properties: {
              session: {
                type: "string",
                description: "Name or key of the session to close, or 'all' to disconnect all sessions",
              },
              host: {
                type: "string",
                description: "Remote host for remote sessions (optional, omit for local)",
              },
            },
            required: ["session"],
          },
        },
        {
          name: "terminal_session_list",
          description: "List all active local and remote terminal sessions, showing session keys, working directories, active environment variables, last activity timestamps, and capacity.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const toolName = request.params.name;

      // P0-A5: SSH/SFTP to remote hosts is gated. Local execution is unaffected;
      // set HELA_NUCLEUS_ALLOW_REMOTE=true to opt in to remote targets.
      if (request.params.arguments?.host && process.env['HELA_NUCLEUS_ALLOW_REMOTE'] !== 'true') {
        throw new McpError(ErrorCode.InvalidParams, "remote hosts are disabled (set HELA_NUCLEUS_ALLOW_REMOTE=true to enable)");
      }

      // Handle session lifecycle tools
      if (toolName === "terminal_session_close") {
        const session = request.params.arguments?.session ? String(request.params.arguments.session) : undefined;
        if (!session) {
          throw new McpError(ErrorCode.InvalidParams, "Session name is required");
        }
        const host = request.params.arguments?.host ? String(request.params.arguments.host) : undefined;
        try {
          const result = await commandExecutor.closeSession({ session, host });
          return textResult(toolName, result);
        } catch (error) {
          if (error instanceof ValidationError) {
            throw new McpError(ErrorCode.InvalidParams, `Validation Error: ${error.message}`);
          }
          if (error instanceof Error) {
            throw new McpError(ErrorCode.InternalError, error.message);
          }
          throw error;
        }
      }

      if (toolName === "terminal_session_list") {
        try {
          const result = await commandExecutor.listSessions();
          return textResult(toolName, result);
        } catch (error) {
          if (error instanceof Error) {
            throw new McpError(ErrorCode.InternalError, error.message);
          }
          throw error;
        }
      }

      // Handle transfer_file tool
      if (toolName === "transfer_file") {
        const source = request.params.arguments?.source ? String(request.params.arguments.source) : undefined;
        const destination = request.params.arguments?.destination ? String(request.params.arguments.destination) : undefined;
        const direction = request.params.arguments?.direction ? String(request.params.arguments.direction) : undefined;
        const host = request.params.arguments?.host ? String(request.params.arguments.host) : undefined;
        const username = request.params.arguments?.username ? String(request.params.arguments.username) : undefined;
        const session = String(request.params.arguments?.session || "default");
        const overwrite = Boolean(request.params.arguments?.overwrite || false);

        if (!source) {
          throw new McpError(ErrorCode.InvalidParams, "Source path is required");
        }
        if (!destination) {
          throw new McpError(ErrorCode.InvalidParams, "Destination path is required");
        }
        if (!direction || !["upload", "download", "local"].includes(direction)) {
          throw new McpError(ErrorCode.InvalidParams, "Direction must be 'upload', 'download', or 'local'");
        }

        if (direction !== "local") {
          if (!host) {
            throw new McpError(ErrorCode.InvalidParams, "Host is required for upload/download operations");
          }
          if (!username) {
            throw new McpError(ErrorCode.InvalidParams, "Username is required for upload/download operations");
          }
        }

        try {
          let result;
          if (direction === "local") {
            result = await commandExecutor.copyFileLocal({ source, destination, overwrite });
          } else {
            result = await commandExecutor.transferFile({
              source,
              destination,
              direction: direction as "upload" | "download",
              host: host!,
              username: username!,
              session,
              overwrite
            });
          }

          return textResult(toolName, result);
        } catch (error) {
          if (error instanceof ValidationError) {
            throw new McpError(ErrorCode.InvalidParams, `Validation Error: ${error.message}`);
          }
          if (error instanceof SecurityError) {
            throw new McpError(ErrorCode.InvalidParams, `Security Error: ${error.message}`);
          }
          if (error instanceof ResourceLimitError) {
            throw new McpError(ErrorCode.InternalError, `Resource Limit: ${error.message}`);
          }
          if (error instanceof RateLimitError) {
            throw new McpError(ErrorCode.InternalError, `Rate Limit: ${error.message}`);
          }
          if (error instanceof SshConnectionError) {
            throw new McpError(ErrorCode.InternalError, `SSH Error: ${error.message}`);
          }
          if (error instanceof TimeoutError) {
            throw new McpError(ErrorCode.InternalError, `Timeout: ${error.message}`);
          }
          if (error instanceof Error) {
            throw new McpError(ErrorCode.InternalError, error.message);
          }
          throw error;
        }
      }

      // Handle execute_command and new terminal util tools
      let command = "";
      
      if (toolName === "terminal_ls") {
        const targetPath = String(request.params.arguments?.path || ".").trim();
        const all = request.params.arguments?.all !== false;
        const long = request.params.arguments?.long !== false;
        command = `ls ${all ? '-a' : ''} ${long ? '-l' : ''} -- '${targetPath.replace(/'/g, "'\\''")}'`;
      } else if (toolName === "terminal_grep") {
        const pattern = String(request.params.arguments?.pattern || "");
        const targetPath = String(request.params.arguments?.path || ".").trim();
        const recursive = request.params.arguments?.recursive !== false;
        const ignoreCase = request.params.arguments?.ignoreCase === true;
        const lineNumber = request.params.arguments?.lineNumber !== false;
        
        let flags = "-";
        if (recursive) flags += "r";
        if (ignoreCase) flags += "i";
        if (lineNumber) flags += "n";
        if (flags === "-") flags = "";
        
        command = `grep ${flags} -- '${pattern.replace(/'/g, "'\\''")}' '${targetPath.replace(/'/g, "'\\''")}'`;
      } else if (toolName === "terminal_cat") {
        const targetPath = String(request.params.arguments?.path || "").trim();
        if (!targetPath) {
          throw new McpError(ErrorCode.InvalidParams, "Path is required for terminal_cat");
        }
        if (!request.params.arguments?.host) {
          throw new McpError(ErrorCode.InvalidParams, "terminal_cat is restricted to remote SSH targets; use hela-membrane read_file for local files");
        }
        const tail = request.params.arguments?.tail === true;
        const lines = Number(request.params.arguments?.lines || 100);
        
        if (tail) {
          command = `tail -n ${lines} -- '${targetPath.replace(/'/g, "'\\''")}'`;
        } else {
          command = `cat -- '${targetPath.replace(/'/g, "'\\''")}'`;
        }
      } else if (toolName === "execute_command") {
        command = String(request.params.arguments?.command || "");
      } else {
        throw new McpError(ErrorCode.MethodNotFound, "Unknown tool");
      }
      
      const host = request.params.arguments?.host ? String(request.params.arguments.host) : undefined;
      const username = request.params.arguments?.username ? String(request.params.arguments.username) : undefined;
      const session = String(request.params.arguments?.session || "default");
      const workingDirectory = request.params.arguments?.workingDirectory ? String(request.params.arguments.workingDirectory) : undefined;
      const timeout = request.params.arguments?.timeout ? Number(request.params.arguments.timeout) : 30000;
      const useRtk = request.params.arguments?.useRtk !== false;
      
      if (!command) {
        throw new McpError(ErrorCode.InvalidParams, "Command is required");
      }
      
      const env = request.params.arguments?.env || {};

      // Validate parameters
      if (host && !username) {
        throw new McpError(ErrorCode.InvalidParams, "Username is required when host is specified");
      }
      
      if (timeout && (timeout < 1000 || timeout > 600000)) {
        throw new McpError(ErrorCode.InvalidParams, "Timeout must be between 1000 and 600000 milliseconds (1 second to 10 minutes)");
      }

      // Validate session name format
      if (session && !/^[a-zA-Z0-9_-]{1,64}$/.test(session)) {
        throw new McpError(ErrorCode.InvalidParams, "Session name must be 1-64 characters and contain only alphanumeric characters, underscores, and hyphens");
      }

      // Validate host format if provided
      if (host && !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid host format");
      }

      try {
        let effectiveCommand = command;
        
        // Auto-detect sudo or su, which conflict with RTK wrappers
        const isSudo = command.trim().startsWith("sudo ") || command.trim().startsWith("su ");
        const shouldRewrite = useRtk && !isSudo && process.env.RTK_MCP_REWRITE !== "false";
        
        if (shouldRewrite) {
          if (host) {
            // For remote commands, use shell-level rewrite if rtk is available remotely.
            // Wrap in a subshell to avoid env var leaks or alias conflicts.
            const escapedCommand = command.replace(/'/g, "'\\''");
            effectiveCommand = `RTK_CMD=$(rtk rewrite '${escapedCommand}' 2>/dev/null || echo '${escapedCommand}'); eval "$RTK_CMD"`;
          } else {
            effectiveCommand = await rewriteWithRtk(command);
          }
        }

        const result = await commandExecutor.executeCommand(effectiveCommand, {
          host,
          username,
          session,
          env: env as Record<string, string>,
          workingDirectory,
          timeout
        });
        
        let processedStdout = result.stdout;
        let stdoutSummarized = false;
        let processedStderr = result.stderr;
        let stderrSummarized = false;
        
        if (shouldRewrite) {
          const resOut = await summarizeWithRtk(result.stdout, 'stdout');
          processedStdout = resOut.content;
          stdoutSummarized = resOut.summarized;
          
          const resErr = await summarizeWithRtk(result.stderr, 'stderr');
          processedStderr = resErr.content;
          stderrSummarized = resErr.summarized;
        }

        // Strict JSON response format
        const response = {
          command,
          executedCommand: effectiveCommand,
          exitCode: result.exitCode || 0,
          stdout: processedStdout,
          stderr: processedStderr,
          rtkSummarized: stdoutSummarized || stderrSummarized,
          workingDirectory: result.workingDirectory || workingDirectory || (host ? undefined : process.cwd())
        };
        
        return textResult(toolName, response);
      } catch (error) {
        // Handle validation errors
        if (error instanceof ValidationError) {
          throw new McpError(ErrorCode.InvalidParams, `Validation Error: ${error.message}`);
        }

        // Handle security errors
        if (error instanceof SecurityError) {
          throw new McpError(ErrorCode.InvalidParams, `Security Error: ${error.message}`);
        }

        // Handle resource limit errors
        if (error instanceof ResourceLimitError) {
          throw new McpError(ErrorCode.InternalError, `Resource Limit: ${error.message}`);
        }

        // Handle rate limit errors
        if (error instanceof RateLimitError) {
          throw new McpError(ErrorCode.InternalError, `Rate Limit: ${error.message}`);
        }

        if (error instanceof CommandExecutionError) {
          // Even if there is an error (like non-zero exit code if caught by exec), return structured data if available
          if (error.stdout || error.stderr) {
            const { content: processedStdout, summarized: stdoutSummarized } = await summarizeWithRtk(error.stdout || "", 'stdout');
            const { content: processedStderr, summarized: stderrSummarized } = await summarizeWithRtk(error.stderr || "", 'stderr');

             const response = {
              command,
              exitCode: error.exitCode || 1,
              stdout: processedStdout,
              stderr: processedStderr,
              rtkSummarized: stdoutSummarized || stderrSummarized,
              error: error.message
            };
            return textResult(toolName, response);
          }
           throw new McpError(ErrorCode.InternalError, `Command failed: ${error.message}`);
        }
        
        if (error instanceof TimeoutError) {
           throw new McpError(ErrorCode.InternalError, `Timeout: ${error.message}`);
        }
        
        if (error instanceof SshConnectionError) {
           throw new McpError(ErrorCode.InternalError, `SSH Error: ${error.message}`);
        }

        if (error instanceof Error) {
          throw new McpError(ErrorCode.InternalError, error.message);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Resource handlers
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "terminal://sessions/status",
          name: "Terminal Sessions Status",
          description: "Current status of active terminal sessions including working directories, environment variables, and connection health",
          mimeType: "application/json",
        },
        {
          uri: "terminal://config",
          name: "Server Configuration",
          description: "Current server configuration including security settings, limits, and timeouts",
          mimeType: "application/json",
        },
        {
          uri: "terminal://system/info",
          name: "System Information",
          description: "Basic system information including OS, architecture, and available shell environments",
          mimeType: "application/json",
        },
        {
          uri: "terminal://tmux/info",
          name: "Tmux Information",
          description: "Tmux availability, version, and server statistics including active sessions, windows, and panes",
          mimeType: "application/json",
        },
        {
          uri: "terminal://tmux/sessions",
          name: "Tmux Sessions",
          description: "List of all active tmux sessions with window counts, creation dates, and attachment status",
          mimeType: "application/json",
        },
        {
          uri: "terminal://tmux/windows/{session}",
          name: "Tmux Windows",
          description: "List of windows within a specific tmux session with activity indicators and layout information",
          mimeType: "application/json",
        },
        {
          uri: "terminal://tmux/panes/{session}",
          name: "Tmux Panes",
          description: "List of panes within a tmux session or specific window with size, history, and activity status",
          mimeType: "application/json",
        },
        {
          uri: "terminal://tmux/panes/{session}/{window}",
          name: "Tmux Panes in Window",
          description: "List of panes within a specific tmux window with detailed pane information",
          mimeType: "application/json",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    switch (uri) {
      case "terminal://sessions/status":
        try {
          const sessionStatus = await commandExecutor.getSessionStatus();
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(sessionStatus, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to retrieve session status: ${error instanceof Error ? error.message : String(error)}`
          );
        }

      case "terminal://config":
        try {
          const config = commandExecutor.getConfig();
          const configInfo = {
            ...config,
            description: {
              sessionTimeout: "Session inactivity timeout in milliseconds (env: SESSION_TIMEOUT_MS)",
              maxRetries: "Maximum SSH connection retry attempts (env: MAX_RETRIES)",
              connectionTimeout: "SSH connection timeout in milliseconds (env: CONNECTION_TIMEOUT_MS)",
              maxConcurrentSessions: "Maximum number of concurrent sessions allowed (env: MAX_CONCURRENT_SESSIONS)",
              maxOutputSize: "Maximum output size in bytes before truncation (env: MAX_OUTPUT_SIZE)",
              enableCommandValidation: "Whether dangerous command patterns are blocked (env: ENABLE_COMMAND_VALIDATION)",
              commandBlacklist: "Comma-separated list of blacklisted command prefixes (env: COMMAND_BLACKLIST)",
              allowedWorkingDirectories: "Comma-separated list of allowed working directory prefixes, null means all allowed (env: ALLOWED_WORKING_DIRECTORIES)",
              rateLimitPerMinute: "Maximum commands per minute per session (env: RATE_LIMIT_PER_MINUTE)",
              rateLimitEnabled: "Whether rate limiting is enabled (env: RATE_LIMIT_ENABLED)",
              maxFileTransferSize: "Maximum file size for transfers in bytes (env: MAX_FILE_TRANSFER_SIZE)",
            },
            timestamp: new Date().toISOString(),
          };
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(configInfo, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to retrieve configuration: ${error instanceof Error ? error.message : String(error)}`
          );
        }

      case "terminal://system/info":
        try {
          const systemInfo = {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            cwd: process.cwd(),
            env: {
              SHELL: process.env.SHELL,
              USER: process.env.USER || process.env.USERNAME,
              HOME: process.env.HOME || process.env.USERPROFILE,
            },
            timestamp: new Date().toISOString(),
          };
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(systemInfo, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to retrieve system information: ${error instanceof Error ? error.message : String(error)}`
          );
        }

      case "terminal://tmux/info":
        try {
          const tmuxInfo = await commandExecutor.getTmuxInfo();
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(tmuxInfo, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to retrieve tmux information: ${error instanceof Error ? error.message : String(error)}`
          );
        }

      case "terminal://tmux/sessions":
        try {
          const tmuxSessions = await commandExecutor.getTmuxSessions();
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(tmuxSessions, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to retrieve tmux sessions: ${error instanceof Error ? error.message : String(error)}`
          );
        }

      default:
        // Handle parameterized tmux resources
        if (uri.startsWith("terminal://tmux/windows/")) {
          const sessionName = uri.replace("terminal://tmux/windows/", "");
          if (!sessionName) {
            throw new McpError(ErrorCode.InvalidRequest, "Session name is required for tmux windows resource");
          }

          try {
            const tmuxWindows = await commandExecutor.getTmuxWindows(sessionName);
            return {
              contents: [
                {
                  uri,
                  mimeType: "application/json",
                  text: JSON.stringify(tmuxWindows, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to retrieve tmux windows for session '${sessionName}': ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        if (uri.startsWith("terminal://tmux/panes/")) {
          const pathParts = uri.replace("terminal://tmux/panes/", "").split("/");
          const sessionName = pathParts[0];
          const windowIndex = pathParts[1] ? parseInt(pathParts[1], 10) : undefined;

          if (!sessionName) {
            throw new McpError(ErrorCode.InvalidRequest, "Session name is required for tmux panes resource");
          }

          try {
            const tmuxPanes = await commandExecutor.getTmuxPanes(sessionName, windowIndex);
            return {
              contents: [
                {
                  uri,
                  mimeType: "application/json",
                  text: JSON.stringify(tmuxPanes, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to retrieve tmux panes for session '${sessionName}'${windowIndex !== undefined ? ` window ${windowIndex}` : ''}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
    }
  });

  return server;
}

async function main() {
  try {
    // Standard I/O setup
    const server = createServer();
    
    // MCP Error handling
    server.onerror = (error) => {
      log.error(`MCP Error: ${error.message}`);
    };
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("Terminal MCP Server (HeLa Nucleus) running on stdio");

    // Handle process signals for graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      log.info(`Received ${signal}, shutting down server gracefully...`);
      try {
        await commandExecutor.disconnect();
        log.info("Server shutdown complete");
        process.exit(0);
      } catch (error) {
        log.error(`Error during shutdown: ${error}`);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      log.error(`Uncaught exception: ${error.message}`);
      if (error.stack) {
        log.error(error.stack);
      }
      gracefulShutdown('uncaughtException');
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      log.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
      gracefulShutdown('unhandledRejection');
    });
  } catch (error) {
    log.error("Server error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  log.error("Server error:", error);
  process.exit(1);
});
