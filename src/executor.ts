import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { log } from './logger.js';

// Custom Error Classes
export class CommandExecutionError extends Error {
  constructor(message: string, public exitCode?: number, public stdout?: string, public stderr?: string) {
    super(message);
    this.name = 'CommandExecutionError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class SshConnectionError extends Error {
  constructor(message: string, public originalError?: any) {
    super(message);
    this.name = 'SshConnectionError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class ResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceLimitError';
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * True when `target` is `root` itself or one of its descendants.
 * Compares whole path segments, so `/srv/application` is not inside `/srv/app`.
 */
export function isPathWithin(target: string, root: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const targetPath = normalize(target);
  const rootPath = normalize(root);
  if (targetPath === rootPath) return true;
  const boundary = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  return targetPath.startsWith(boundary);
}

// Configuration interface
export interface ExecutorConfig {  sessionTimeout: number;
  maxRetries: number;
  connectionTimeout: number;
  maxConcurrentSessions: number;
  maxOutputSize: number;
  enableCommandValidation: boolean;
  commandBlacklist: string[];
  allowedWorkingDirectories: string[] | null; // null means all directories allowed
  rateLimitPerMinute: number; // max commands per minute per session
  rateLimitEnabled: boolean;
  maxFileTransferSize: number; // max file size for transfers in bytes
}

// Default configuration with environment variable overrides
function getConfig(): ExecutorConfig {
  return {
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT_MS || '1200000', 10), // 20 minutes
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT_MS || '30000', 10),
    maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '10', 10),
    maxOutputSize: parseInt(process.env.MAX_OUTPUT_SIZE || '5242880', 10), // 5MB default
    enableCommandValidation: process.env.ENABLE_COMMAND_VALIDATION !== 'false',
    commandBlacklist: (process.env.COMMAND_BLACKLIST || '').split(',').filter(Boolean),
    allowedWorkingDirectories: process.env.ALLOWED_WORKING_DIRECTORIES 
      ? process.env.ALLOWED_WORKING_DIRECTORIES.split(',').map(dir => dir.trim()).filter(Boolean)
      : null,
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10),
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    maxFileTransferSize: parseInt(process.env.MAX_FILE_TRANSFER_SIZE || '104857600', 10), // 100MB default
  };
}

export class CommandExecutor {
  private sessions: Map<string, {
    client: Client | null;
    connection: Promise<void> | null;
    timeout: NodeJS.Timeout | null;
    host?: string;
    username?: string;
    env?: Record<string, string>;
    shell?: any;
    shellReady?: boolean;
    workingDirectory?: string;
    lastActivity?: number;
    retryCount?: number;
    maxRetries?: number;
    commandTimestamps?: number[]; // Track command execution times for rate limiting
  }> = new Map();
  
  private config: ExecutorConfig;
  
  // Dangerous command patterns that could be security risks
  private static readonly DANGEROUS_PATTERNS: RegExp[] = [
    /rm\s+(-[a-zA-Z0-9-]+\s+)*(\/|\/\*|~|~\/)(\s|$|[;&|])/i, // rm with root or home directory path
    /rm\s+.*--no-preserve-root/i,                              // rm with no-preserve-root
    /mkfs\./i,                                                // filesystem formatting
    /dd\s+.*of=\/dev\//i,                                    // dd to device
    />\s*\/dev\/sd[a-z]/i,                                   // write to disk device
    /chmod\s+(-[a-zA-Z0-9-]+\s+)*777\s+(\/|\/\*)(\s|$|[;&|])/i, // chmod 777 on root
    /chown\s+(-[a-zA-Z0-9-]+\s+)*[^\s]+\s+(\/|\/\*)(\s|$|[;&|])/i, // chown on root
    /:(){ :\|:& };:/,                                        // fork bomb
    /\|\s*mail\s/i,                                          // pipe to mail
    /curl.*\|\s*(ba)?sh/i,                                   // curl pipe to shell
    /wget.*\|\s*(ba)?sh/i,                                   // wget pipe to shell
    /\beval\s+.*\$\(/i,                                      // eval with command substitution
    />\s*\/etc\//i,                                          // write to /etc
    />\s*\/boot\//i,                                         // write to /boot
  ];

  // Session name validation pattern
  private static readonly SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

  constructor(customConfig?: Partial<ExecutorConfig>) {
    this.config = { ...getConfig(), ...customConfig };
    log.info(`CommandExecutor initialized with config: maxSessions=${this.config.maxConcurrentSessions}, maxOutput=${this.config.maxOutputSize}, commandValidation=${this.config.enableCommandValidation}`);
  }

  /**
   * Validate session name format
   */
  validateSessionName(sessionName: string): void {
    if (!sessionName || typeof sessionName !== 'string') {
      throw new ValidationError('Session name is required and must be a string');
    }
    if (!CommandExecutor.SESSION_NAME_PATTERN.test(sessionName)) {
      throw new ValidationError('Session name must be 1-64 characters and contain only alphanumeric characters, underscores, and hyphens');
    }
  }

  /**
   * Validate command for dangerous patterns
   */
  validateCommand(command: string): void {
    if (!this.config.enableCommandValidation) {
      return;
    }

    if (!command || typeof command !== 'string') {
      throw new ValidationError('Command is required and must be a string');
    }

    const trimmedCommand = command.trim();
    if (trimmedCommand.length === 0) {
      throw new ValidationError('Command cannot be empty');
    }

    if (trimmedCommand.length > 10000) {
      throw new ValidationError('Command exceeds maximum length of 10000 characters');
    }

    // Check against blacklisted commands
    for (const blacklisted of this.config.commandBlacklist) {
      if (trimmedCommand.toLowerCase().startsWith(blacklisted.toLowerCase())) {
        throw new SecurityError(`Command '${blacklisted}' is blacklisted`);
      }
    }

    // Check for dangerous patterns
    for (const pattern of CommandExecutor.DANGEROUS_PATTERNS) {
      if (pattern.test(trimmedCommand)) {
        log.warn(`Potentially dangerous command detected: ${trimmedCommand.substring(0, 100)}`);
        throw new SecurityError(`Command contains potentially dangerous pattern. If this is intentional, set ENABLE_COMMAND_VALIDATION=false`);
      }
    }
  }

  /**
   * Validate working directory
   */
  async validateWorkingDirectory(directory: string, isRemote: boolean = false): Promise<void> {
    if (!directory || typeof directory !== 'string') {
      throw new ValidationError('Working directory must be a non-empty string');
    }

    // Check against allowed directories if configured
    if (this.config.allowedWorkingDirectories !== null) {
      const isAllowed = this.config.allowedWorkingDirectories.some(allowed =>
        isPathWithin(directory, allowed)
      );
      if (!isAllowed) {
        throw new SecurityError(`Working directory '${directory}' is not in the allowed directories list`);
      }
    }

    // For local execution, verify directory exists
    if (!isRemote) {
      try {
        const stats = fs.statSync(directory);
        if (!stats.isDirectory()) {
          throw new ValidationError(`Path '${directory}' is not a directory`);
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          throw new ValidationError(`Working directory '${directory}' does not exist`);
        }
        if (error.code === 'EACCES') {
          throw new ValidationError(`No permission to access working directory '${directory}'`);
        }
        throw error;
      }
    }
  }

  /**
   * Check if we can create a new session
   */
  private checkSessionLimit(): void {
    const activeCount = this.sessions.size;
    if (activeCount >= this.config.maxConcurrentSessions) {
      throw new ResourceLimitError(`Maximum concurrent sessions limit reached (${this.config.maxConcurrentSessions}). Close existing sessions or increase MAX_CONCURRENT_SESSIONS.`);
    }
  }

  /**
   * Truncate output if it exceeds maximum size
   */
  private truncateOutput(output: string, label: string = 'output'): string {
    if (output.length > this.config.maxOutputSize) {
      const truncated = output.substring(0, this.config.maxOutputSize);
      const truncatedBytes = output.length - this.config.maxOutputSize;
      log.warn(`${label} truncated: ${truncatedBytes} bytes removed`);
      return truncated + `\n\n[OUTPUT TRUNCATED: ${truncatedBytes} bytes removed. Set MAX_OUTPUT_SIZE to increase limit.]`;
    }
    return output;
  }

  /**
   * Get current configuration
   */
  getConfig(): ExecutorConfig {
    return { ...this.config };
  }

  /**
   * Check and enforce rate limiting for a session
   */
  private checkRateLimit(sessionKey: string): void {
    if (!this.config.rateLimitEnabled) {
      return;
    }

    const session = this.sessions.get(sessionKey);
    if (!session) {
      return; // New session, will be created
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Initialize or clean up old timestamps
    if (!session.commandTimestamps) {
      session.commandTimestamps = [];
    }

    // Remove timestamps older than 1 minute
    session.commandTimestamps = session.commandTimestamps.filter(ts => ts > oneMinuteAgo);

    // Check if limit exceeded
    if (session.commandTimestamps.length >= this.config.rateLimitPerMinute) {
      const oldestTimestamp = session.commandTimestamps[0];
      const waitTime = Math.ceil((oldestTimestamp + 60000 - now) / 1000);
      throw new RateLimitError(
        `Rate limit exceeded: ${this.config.rateLimitPerMinute} commands per minute. ` +
        `Please wait ${waitTime} seconds or increase RATE_LIMIT_PER_MINUTE.`
      );
    }

    // Record this command
    session.commandTimestamps.push(now);
    this.sessions.set(sessionKey, session);
  }

  /**
   * Get rate limit status for a session
   */
  getRateLimitStatus(sessionKey: string): { remaining: number; resetIn: number; limit: number } {
    const session = this.sessions.get(sessionKey);
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    if (!session || !session.commandTimestamps) {
      return {
        remaining: this.config.rateLimitPerMinute,
        resetIn: 0,
        limit: this.config.rateLimitPerMinute
      };
    }

    const recentCommands = session.commandTimestamps.filter(ts => ts > oneMinuteAgo);
    const remaining = Math.max(0, this.config.rateLimitPerMinute - recentCommands.length);
    const resetIn = recentCommands.length > 0 
      ? Math.ceil((recentCommands[0] + 60000 - now) / 1000)
      : 0;

    return {
      remaining,
      resetIn: Math.max(0, resetIn),
      limit: this.config.rateLimitPerMinute
    };
  }

  /**
   * Check if a path contains directory traversal segments (..)
   */
  private hasPathTraversal(filePath: string): boolean {
    const segments = filePath.split(/[\\/]/);
    return segments.some(seg => seg.trim() === '..');
  }

    private getSessionKey(host: string | undefined, sessionName: string): string {
    return `${host || 'local'}-${sessionName}`;
  }

  async connect(host: string, username: string, sessionName: string = 'default'): Promise<void> {
    // Validate session name
    this.validateSessionName(sessionName);
    
    const sessionKey = this.getSessionKey(host, sessionName);
    const session = this.sessions.get(sessionKey);
    
    // Check if session exists and is still valid
    if (session?.connection && session?.client && await this.isConnectionHealthy(session.client)) {
      log.info(`Reusing existing healthy session: ${sessionKey}`);
      this.updateActivity(sessionKey);
      return session.connection;
    }
    
    // Clean up invalid session
    if (session) {
      log.info(`Session ${sessionKey} is invalid, cleaning up and creating new session`);
      await this.disconnectSession(sessionKey);
    }

    // Check session limit before creating new session
    this.checkSessionLimit();

    // Attempt connection with retry logic
    return this.connectWithRetry(host, username, sessionName);
  }

  private async isConnectionHealthy(client: Client): Promise<boolean> {
    return new Promise((resolve) => {
      if (!client) {
        resolve(false);
        return;
      }
      
      // Set a timeout for the health check
      const healthCheckTimeout = setTimeout(() => {
        log.debug('Connection health check timed out');
        resolve(false);
      }, 5000);

      // Use exec with a simple echo command to verify connection
      try {
        client.exec('echo "health-check-ok"', (err, stream) => {
          if (err) {
            clearTimeout(healthCheckTimeout);
            log.debug(`Connection health check failed: ${err.message}`);
            resolve(false);
            return;
          }

          let output = '';
          
          stream.on('data', (data: Buffer) => {
            output += data.toString();
          });

          stream.on('close', (code: number) => {
            clearTimeout(healthCheckTimeout);
            const isHealthy = code === 0 && output.includes('health-check-ok');
            log.debug(`Connection health check result: ${isHealthy ? 'healthy' : 'unhealthy'}`);
            resolve(isHealthy);
          });

          stream.on('error', (err: Error) => {
            clearTimeout(healthCheckTimeout);
            log.debug(`Connection health check stream error: ${err.message}`);
            resolve(false);
          });
        });
      } catch (error) {
        clearTimeout(healthCheckTimeout);
        log.debug(`Connection health check error: ${error}`);
        resolve(false);
      }
    });
  }

  private async connectWithRetry(host: string, username: string, sessionName: string): Promise<void> {
    let retryCount = 0;
    const maxRetries = this.config.maxRetries;

    while (retryCount < maxRetries) {
      try {
        log.info(`Attempting connection to ${host} (attempt ${retryCount + 1}/${maxRetries})`);
        await this.establishConnection(host, username, sessionName);
        log.info(`Successfully connected to ${host}`);
        return;
      } catch (error: any) {
        retryCount++;
        const isLastAttempt = retryCount >= maxRetries;
        
        log.error(`Connection attempt ${retryCount} failed: ${error.message}`);
          
        if (isLastAttempt) {
          throw new SshConnectionError(`Failed to connect to ${host} after ${maxRetries} attempts. Last error: ${error.message}`, error);
        }
        
        if (!isLastAttempt) {
          const retryDelay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000); // Exponential backoff, max 10s
          log.info(`Retrying connection in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
  }

  private async establishConnection(host: string, username: string, sessionName: string): Promise<void> {
    const sessionKey = this.getSessionKey(host, sessionName);
    
    try {
      let privateKeyPath = process.env.SSH_KEY_PATH;
      if (!privateKeyPath) {
        const sshDir = path.join(os.homedir(), '.ssh');
        const candidateKeys = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
        for (const candidate of candidateKeys) {
          const fullPath = path.join(sshDir, candidate);
          if (fs.existsSync(fullPath)) {
            privateKeyPath = fullPath;
            break;
          }
        }
      }

      if (!privateKeyPath || !fs.existsSync(privateKeyPath)) {
        throw new SshConnectionError(`No SSH private key found (checked id_ed25519, id_rsa, id_ecdsa in ~/.ssh). Please ensure SSH key-based authentication is set up or set SSH_KEY_PATH environment variable.`);
      }
      
      const privateKey = fs.readFileSync(privateKeyPath);

      const client = new Client();
      const connection = new Promise<void>((resolve, reject) => {
        const connectionTimer = setTimeout(() => {
          reject(new TimeoutError(`Connection timeout after ${this.config.connectionTimeout}ms`));
          client.destroy();
        }, this.config.connectionTimeout);

        client
          .on('ready', () => {
            clearTimeout(connectionTimer);
            log.info(`SSH connection established for session: ${sessionKey}`);
            this.resetTimeout(sessionKey);
            
            // Create interactive shell
            client.shell({ term: 'xterm-256color' }, (err, stream) => {
              if (err) {
                log.error(`Failed to create interactive shell: ${err.message}`);
                reject(new SshConnectionError(`Failed to create shell: ${err.message}`));
                return;
              }
              
              log.info(`Interactive shell created for session ${sessionKey}`);
              
              // Update session with shell information
              const sessionData = this.sessions.get(sessionKey);
              if (sessionData) {
                sessionData.shell = stream;
                sessionData.shellReady = true;
                sessionData.workingDirectory = '/';
                this.sessions.set(sessionKey, sessionData);
              }
              
              // Handle shell events
              stream.on('close', () => {
                log.info(`Interactive shell closed for session ${sessionKey}`);
                const sessionData = this.sessions.get(sessionKey);
                if (sessionData) {
                  sessionData.shellReady = false;
                  this.sessions.set(sessionKey, sessionData);
                }
              });
              
              stream.on('error', (err: Error) => {
                log.error(`Shell error for session ${sessionKey}: ${err.message}`);
                const sessionData = this.sessions.get(sessionKey);
                if (sessionData) {
                  sessionData.shellReady = false;
                  this.sessions.set(sessionKey, sessionData);
                }
              });
              
              // Initialize shell
              stream.write('export PS1="$ "' + '\n');
              stream.write('echo "Shell ready"' + '\n');
              
              resolve();
            });
          })
          .on('error', (err) => {
            clearTimeout(connectionTimer);
            log.error(`SSH connection error for session ${sessionKey}: ${err.message}`);
            
            // Provide more specific error messages
            let errorMessage = err.message;
            if (err.message.includes('ECONNREFUSED')) {
              errorMessage = `Connection refused to ${host}. Check if SSH service is running and host is reachable.`;
            } else if (err.message.includes('ETIMEDOUT')) {
              errorMessage = `Connection timeout to ${host}. Check network connectivity and firewall settings.`;
            } else if (err.message.includes('ENOTFOUND')) {
              errorMessage = `Host ${host} not found. Check hostname or DNS resolution.`;
            } else if (err.message.includes('authentication')) {
              errorMessage = `Authentication failed for user ${username} on ${host}. Check SSH key permissions and user credentials.`;
            }
            
            reject(new SshConnectionError(errorMessage, err));
          })
          .connect({
            host: host,
            username: username,
            privateKey: privateKey,
            keepaliveInterval: 60000,
            readyTimeout: this.config.connectionTimeout,
            algorithms: {
              serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256']
            }
          });
      });

      // Store session information
      this.sessions.set(sessionKey, {
        client,
        connection,
        timeout: null,
        host,
        username,
        shell: null,
        shellReady: false,
        workingDirectory: '/',
        lastActivity: Date.now(),
        retryCount: 0,
        maxRetries: this.config.maxRetries
      });

      return connection;
    } catch (error: any) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new SshConnectionError(`SSH key file does not exist. Please ensure SSH key-based authentication is set up.`);
      }
      throw error;
    }
  }

  private updateActivity(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.lastActivity = Date.now();
      this.sessions.set(sessionKey, session);
      this.resetTimeout(sessionKey);
    }
  }

  /**
   * Safely removes matching quotes from the beginning and end of a string.
   */
  private removeMatchingQuotes(value: string): string {
    if (value.length < 2) {
      return value;
    }

    const firstChar = value[0];
    const lastChar = value[value.length - 1];

    if ((firstChar === '"' && lastChar === '"') || (firstChar === "'" && lastChar === "'")) {
      const quoteType = firstChar;
      const middle = value.slice(1, -1);
      if (!middle.includes(quoteType)) {
        return middle;
      }
    }

    return value;
  }

  private resetTimeout(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    if (session.timeout) {
      clearTimeout(session.timeout);
    }

    session.timeout = setTimeout(async () => {
      log.info(`Session ${sessionKey} timeout, disconnecting`);
      await this.disconnectSession(sessionKey);
    }, this.config.sessionTimeout);

    this.sessions.set(sessionKey, session);
  }

  async executeCommand(
    command: string,
    options: {
      host?: string;
      username?: string;
      session?: string;
      env?: Record<string, string>;
      workingDirectory?: string;
      timeout?: number;
    } = {}
  ): Promise<{stdout: string; stderr: string; exitCode?: number; workingDirectory?: string}> {
    const { 
      host, 
      username, 
      session = 'default', 
      env = {}, 
      workingDirectory,
      timeout = 30000 
    } = options;

    // Validate session name
    this.validateSessionName(session);
    
    // Validate command
    this.validateCommand(command);

    // Validate working directory if provided
    if (workingDirectory) {
      await this.validateWorkingDirectory(workingDirectory, !!host);
    }

    const sessionKey = this.getSessionKey(host, session);

    // Check rate limiting
    this.checkRateLimit(sessionKey);

    // If host is specified, use SSH execution
    if (host) {
      if (!username) {
        throw new CommandExecutionError('Username is required when using SSH');
      }

      // Validate username format
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,31}$/.test(username)) {
        throw new ValidationError('Invalid username format');
      }
      
      try {
        // Ensure we have a valid connection
        await this.connect(host, username, session);
        const sessionData = this.sessions.get(sessionKey);
        
        if (!sessionData || !sessionData.client) {
          throw new SshConnectionError(`Failed to establish SSH connection to ${host}`);
        }
        
        this.updateActivity(sessionKey);
        
        // Update working directory if specified
        if (workingDirectory && sessionData.workingDirectory !== workingDirectory) {
          await this.changeWorkingDirectory(sessionKey, workingDirectory);
        }

        // Execute command using the most appropriate method
        let result;
        if (sessionData.shellReady && sessionData.shell) {
          log.info(`Executing command using interactive shell: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
          result = await this.executeWithShell(sessionKey, command, env, timeout);
        } else {
          log.info(`Executing command using exec: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
          result = await this.executeWithExec(sessionKey, command, env, timeout);
        }

        // Truncate output if necessary
        result.stdout = this.truncateOutput(result.stdout, 'stdout');
        result.stderr = this.truncateOutput(result.stderr, 'stderr');
        
        return result;
      } catch (error: any) {
        log.error(`Command execution failed: ${error.message}`);
        throw error;
      }
    } 
    // Execute command locally
    else {
      // Check session limit for new local sessions
      if (!this.sessions.has(sessionKey)) {
        this.checkSessionLimit();
      }
      
      log.info(`Executing command locally: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
      const result = await this.executeLocally(sessionKey, command, env, workingDirectory, timeout);
      
      // Truncate output if necessary
      result.stdout = this.truncateOutput(result.stdout, 'stdout');
      result.stderr = this.truncateOutput(result.stderr, 'stderr');
      
      return result;
    }
  }

  private async changeWorkingDirectory(sessionKey: string, newWorkingDirectory: string): Promise<void> {
    const sessionData = this.sessions.get(sessionKey);
    if (!sessionData || !sessionData.shellReady || !sessionData.shell) {
      return;
    }

    return new Promise((resolve, reject) => {
      const uniqueMarker = `CD_END_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      let commandFinished = false;

      const dataHandler = (data: Buffer) => {
        const str = data.toString();
        if (str.includes(uniqueMarker)) {
          commandFinished = true;
          sessionData.shell.removeListener('data', dataHandler);
          sessionData.shell.removeListener('error', errorHandler);
          clearTimeout(timeout);
          
          // Update working directory in session
          sessionData.workingDirectory = newWorkingDirectory;
          this.sessions.set(sessionKey, sessionData);
          
          resolve();
        }
      };

      const errorHandler = (err: Error) => {
        sessionData.shell.removeListener('data', dataHandler);
        sessionData.shell.removeListener('error', errorHandler);
        clearTimeout(timeout);
        reject(err);
      };

      sessionData.shell.on('data', dataHandler);
      sessionData.shell.on('error', errorHandler);

      sessionData.shell.write(`cd "${newWorkingDirectory}" && pwd && echo "${uniqueMarker}"\n`);

      const timeout = setTimeout(() => {
        if (!commandFinished) {
          sessionData.shell.removeListener('data', dataHandler);
          sessionData.shell.removeListener('error', errorHandler);
          reject(new TimeoutError(`Working directory change timed out`));
        }
      }, 5000);
    });
  }

  private async executeWithShell(
    sessionKey: string, 
    command: string, 
    env: Record<string, string>, 
    timeout: number
  ): Promise<{stdout: string; stderr: string; exitCode?: number; workingDirectory?: string}> {
    const sessionData = this.sessions.get(sessionKey);
    if (!sessionData || !sessionData.shell) {
      throw new CommandExecutionError('Shell session not available');
    }

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let commandFinished = false;
      const uniqueMarker = `CMD_END_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      
      // Build environment variable setup
      const envSetup = Object.entries(env)
        .map(([key, value]) => `export ${key}="${String(value).replace(/"/g, '\\"')}"`)
        .join(' && ');
      
      // Build full command with environment variables
      const fullCommand = envSetup ? `${envSetup} && ${command}` : command;
      
      const dataHandler = (data: Buffer) => {
        const str = data.toString();
        log.debug(`Shell output: ${str}`);
        
        if (str.includes(uniqueMarker)) {
          commandFinished = true;
          
          // Extract command output more reliably
          const lines = stdout.split('\n');
          let commandOutput = '';
          let foundCommand = false;
          let exitCode = 0;
          
          for (const line of lines) {
            if (line.includes(`echo "Exit code: $?"`)) {
              const match = line.match(/Exit code: (\d+)/);
              if (match) {
                exitCode = parseInt(match[1], 10);
              }
              continue;
            }
            
            if (foundCommand) {
              if (line.includes(uniqueMarker)) {
                break;
              }
              commandOutput += line + '\n';
            } else if (line.includes(fullCommand) || line.includes(command)) {
              foundCommand = true;
            }
          }
          
          resolve({ 
            stdout: commandOutput.trim(), 
            stderr: stderr.trim(),
            exitCode: exitCode,
            workingDirectory: sessionData.workingDirectory
          });
          
          sessionData.shell.removeListener('data', dataHandler);
          sessionData.shell.removeListener('error', errorHandler);
          clearTimeout(timeoutId);
        } else if (!commandFinished) {
          stdout += str;
        }
      };
      
      const errorHandler = (err: Error) => {
        stderr += err.message;
        sessionData.shell.removeListener('data', dataHandler);
        sessionData.shell.removeListener('error', errorHandler);
        clearTimeout(timeoutId);
        reject(new CommandExecutionError(err.message, undefined, stdout, stderr));
      };
      
      sessionData.shell.on('data', dataHandler);
      sessionData.shell.on('error', errorHandler);
      
      // Execute command with proper output capture
      sessionData.shell.write(`${fullCommand}; echo "Exit code: $?"\n`);
      sessionData.shell.write(`echo "${uniqueMarker}"\n`);
      
      const timeoutId = setTimeout(() => {
        if (!commandFinished) {
          stderr += "Command execution timed out";
          sessionData.shell.removeListener('data', dataHandler);
          sessionData.shell.removeListener('error', errorHandler);
          resolve({ stdout, stderr, exitCode: 124, workingDirectory: sessionData.workingDirectory }); // 124 is timeout exit code
        }
      }, timeout);
    });
  }

  private async executeWithExec(
    sessionKey: string, 
    command: string, 
    env: Record<string, string>, 
    timeout: number
  ): Promise<{stdout: string; stderr: string; exitCode?: number; workingDirectory?: string}> {
    const sessionData = this.sessions.get(sessionKey);
    if (!sessionData || !sessionData.client) {
      throw new CommandExecutionError('SSH client not available');
    }

    return new Promise((resolve, reject) => {
      // Build environment variable setup
      const envSetup = Object.entries(env)
        .map(([key, value]) => `export ${key}="${String(value).replace(/"/g, '\\"')}"`)
        .join(' && ');
      
      // Build full command with environment variables
      const fullCommand = envSetup ? `${envSetup} && ${command}` : command;
      
      if (!sessionData.client) {
        reject(new CommandExecutionError('SSH client not available'));
        return;
      }

      sessionData.client.exec(`/bin/bash --login -c "${fullCommand.replace(/"/g, '\\"')}"`, (err, stream) => {
        if (err) {
          reject(new CommandExecutionError(err.message));
          return;
        }

        let stdout = "";
        let stderr = '';
        let exitCode = 0;

        stream
          .on("data", (data: Buffer) => {
            this.updateActivity(sessionKey);
            stdout += data.toString();
          })
          .stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          })
          .on('close', (code: number) => {
            exitCode = code;
            resolve({ stdout, stderr, exitCode, workingDirectory: sessionData.workingDirectory });
          })
          .on('error', (err) => {
            reject(new CommandExecutionError(err.message, undefined, stdout, stderr));
          });

        // Set timeout for the entire operation
        setTimeout(() => {
          stream.close();
          resolve({ 
            stdout, 
            stderr: stderr + "Command execution timed out", 
            exitCode: 124,
            workingDirectory: sessionData.workingDirectory
          });
        }, timeout);
      });
    });
  }

  private async executeLocally(
    sessionKey: string, 
    command: string, 
    env: Record<string, string>, 
    workingDirectory?: string,
    timeout: number = 30000
  ): Promise<{stdout: string; stderr: string; exitCode?: number; workingDirectory?: string}> {
    // Get or create local session
    let sessionData = this.sessions.get(sessionKey);
    
    if (!sessionData) {
      sessionData = {
        client: null,
        connection: null,
        timeout: null,
        env: { ...env },
        workingDirectory: workingDirectory || process.cwd()
      };
      this.sessions.set(sessionKey, sessionData);
      log.info(`Creating new local session: ${sessionKey}`);
    } else {
      // Merge environment variables
      if (!sessionData.env) {
        sessionData.env = {};
      }
      sessionData.env = { ...sessionData.env, ...env };
      
      // Update working directory if specified
      if (workingDirectory) {
        sessionData.workingDirectory = workingDirectory;
      }
      
      this.sessions.set(sessionKey, sessionData);
    }
    
    this.resetTimeout(sessionKey);
    
    // Intercept only simple cd commands. Shell chains must be executed by the shell.
    const cdMatch = /[;&|]/.test(command)
      ? null
      : command.match(/^\s*cd(?:\s+((?:(?:-[A-Za-z]+)\s+)*(?:"[^"]*"|'[^']*'|\S+)))?(?:\s+.*)?\s*$/);
    if (cdMatch) {
      let targetDir = cdMatch[1] ? cdMatch[1].trim() : '';
      targetDir = this.removeMatchingQuotes(targetDir);

      if (!targetDir || targetDir === '~') {
        targetDir = os.homedir();
      } else if (targetDir.startsWith('~/')) {
        targetDir = path.join(os.homedir(), targetDir.slice(2));
      } else if (!path.isAbsolute(targetDir)) {
        targetDir = path.resolve(sessionData.workingDirectory || process.cwd(), targetDir);
      }

      try {
        await this.validateWorkingDirectory(targetDir, false);
        sessionData.workingDirectory = targetDir;
        this.sessions.set(sessionKey, sessionData);
        log.info(`Changed directory to ${targetDir} in session ${sessionKey}`);
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          workingDirectory: targetDir
        };
      } catch (err: any) {
        return {
          stdout: '',
          stderr: `bash: cd: ${cdMatch[1] || ''}: ${err.message}\n`,
          exitCode: 1,
          workingDirectory: sessionData.workingDirectory
        };
      }
    }

    if (command.trim() === 'pwd') {
      const cwd = sessionData.workingDirectory || process.cwd();
      return {
        stdout: `${cwd}\n`,
        stderr: '',
        exitCode: 0,
        workingDirectory: cwd
      };
    }

    // Check if command is trying to set environment variables
    const exportMatch = command.match(/^\s*export\s+([^=;|&]+)=([^;|&]*)(?:\s*$|\s*;|\s*&&|\s*\|\|)/);
    if (exportMatch) {
      const [, varName, varValue] = exportMatch;
      
      // Check if there are additional commands after the export
      const hasChainedCommands = /^\s*export\s+[^=;|&]+=[^;|&]*\s*[;|&]/.test(command);
      
      if (hasChainedCommands) {
        log.info(`Export command with chained commands detected, executing normally: ${command}`);
      } else {
        const cleanValue = this.removeMatchingQuotes(varValue.trim());
        if (!sessionData.env) sessionData.env = {};
        sessionData.env[varName.trim()] = cleanValue;
        this.sessions.set(sessionKey, sessionData);
        log.info(`Set environment variable ${varName.trim()}=${cleanValue} in session ${sessionKey}`);
        
        return Promise.resolve({ 
          stdout: `Environment variable ${varName.trim()} set to ${cleanValue}`, 
          stderr: '', 
          exitCode: 0,
          workingDirectory: sessionData.workingDirectory
        });
      }
    }
    
    return new Promise((resolve, reject) => {
      const envVars = { ...process.env, ...sessionData.env };
      
      log.info(`Executing local command: ${command}`);
      // Run from a temporary script rather than `sh -c "<command>"`. With -c the
      // command text sits in the shell's own argv, so `pkill -f <pattern>` matches
      // and kills the wrapper mid-compound (and `pgrep -f` reports a false
      // positive). A script file keeps the pattern out of every process's command
      // line while preserving shell semantics.
      const scriptPath = path.join(
        os.tmpdir(),
        `hela-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`
      );
      fs.writeFileSync(scriptPath, command, { mode: 0o700 });
      const cleanupScript = () => {
        try { fs.unlinkSync(scriptPath); } catch { /* already removed */ }
      };

      const childProcess = execFile('/bin/sh', [scriptPath], { 
        env: envVars,
        cwd: sessionData.workingDirectory,
        timeout: timeout,
        maxBuffer: this.config.maxOutputSize
      }, (error, stdout, stderr) => {
        cleanupScript();
        let exitCode = 0;
        if (error) {
           exitCode = typeof error.code === 'number' ? error.code : 1;
        }
        
        // Check for timeout: error.killed is true if process was killed by signal
        if (error && (error.killed || (error as any).code === 'ETIMEDOUT')) {
          resolve({ 
            stdout, 
            stderr: stderr + `\nCommand timed out after ${timeout}ms`, 
            exitCode: 124,
            workingDirectory: sessionData.workingDirectory
          });
        } else {
          resolve({ 
            stdout, 
            stderr, 
            exitCode, 
            workingDirectory: sessionData.workingDirectory 
          });
        }
      });

      childProcess.on('error', (error) => {
        cleanupScript();
        reject(new CommandExecutionError(`Process error: ${error.message}`));
      });
    });
  }

  private async disconnectSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    try {
      log.info(`Disconnecting session: ${sessionKey}`);
      
      if (session.shell) {
        try {
          session.shell.end();
          session.shellReady = false;
        } catch (error) {
          log.warn(`Error closing shell: ${error}`);
        }
      }
      
      if (session.client) {
        try {
          session.client.end();
        } catch (error) {
          log.warn(`Error closing SSH client: ${error}`);
        }
      }
      
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      
      this.sessions.delete(sessionKey);
      log.info(`Successfully disconnected session: ${sessionKey}`);
    } catch (error) {
      log.error(`Error during session disconnection ${sessionKey}: ${error}`);
      this.sessions.delete(sessionKey);
    }
  }

  async disconnect(): Promise<void> {
    log.info(`Disconnecting all sessions...`);
    const sessionKeys = Array.from(this.sessions.keys());
    if (sessionKeys.length === 0) return;

    await Promise.allSettled(sessionKeys.map(k => this.disconnectSession(k)));
    this.sessions.clear();
    log.info(`All sessions disconnected`);
  }

  /**
   * Close a specific session by name/key or all sessions
   */
  async closeSession(options: { session: string; host?: string }): Promise<{ success: boolean; session: string; message: string }> {
    const { session, host } = options;
    if (!session || typeof session !== "string") {
      throw new ValidationError("Session name must be a non-empty string");
    }

    if (session === "all") {
      const count = this.sessions.size;
      await this.disconnect();
      return {
        success: true,
        session: "all",
        message: `All sessions successfully disconnected and closed (${count} sessions closed)`,
      };
    }

    // Direct sessionKey match (e.g. "local-default" or "remote-host-user-default")
    if (this.sessions.has(session)) {
      await this.disconnectSession(session);
      return {
        success: true,
        session,
        message: `Session "${session}" successfully closed`,
      };
    }

    // Resolving via host & sessionName
    const sessionKey = this.getSessionKey(host, session);
    if (this.sessions.has(sessionKey)) {
      await this.disconnectSession(sessionKey);
      return {
        success: true,
        session: sessionKey,
        message: `Session "${sessionKey}" successfully closed`,
      };
    }

    return {
      success: false,
      session,
      message: `Session "${session}" not found or already closed`,
    };
  }

  /**
   * List active sessions and capacity
   */
  async listSessions(): Promise<any> {
    const status = await this.getSessionStatus();
    return {
      ...status,
      maxConcurrentSessions: this.config.maxConcurrentSessions,
      availableSlots: Math.max(0, this.config.maxConcurrentSessions - status.summary.totalSessions),
    };
  }

  async getSessionStatus(): Promise<any> {
    const sessions = await Promise.all(Array.from(this.sessions.entries()).map(async ([sessionKey, session]) => {
      const isLocal = !session.host || session.host === "local";
      const isActive = isLocal ? true : Boolean(session.client && session.connection);
      const isHealthy = isLocal ? true : (isActive ? await this.isConnectionHealthy(session.client!) : false);
      const lastActivity = session.lastActivity ? new Date(session.lastActivity).toISOString() : null;

      return {
        sessionKey,
        host: session.host || 'local',
        username: session.username,
        isActive,
        isHealthy,
        workingDirectory: session.workingDirectory,
        environmentVariables: session.env ? Object.keys(session.env) : [],
        lastActivity,
        shellReady: session.shellReady || false,
      };
    }));

    const localSessions = sessions.filter(s => s.host === 'local');
    const remoteSessions = sessions.filter(s => s.host !== 'local');

    return {
      summary: {
        totalSessions: sessions.length,
        activeSessions: sessions.filter(s => s.isActive).length,
        localSessions: localSessions.length,
        remoteSessions: remoteSessions.length,
      },
      sessions: {
        local: localSessions,
        remote: remoteSessions,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // Tmux-related methods
  async getTmuxSessions(options: { host?: string; username?: string; session?: string } = {}): Promise<any> {
    try {
      // Use -F for machine readable output
      // Format: session_name,windows_count,created_time,flags,attached
      const cmd = `tmux list-sessions -F "#{session_name},#{session_windows},#{session_created},#{session_flags},#{?session_attached,attached,detached}" 2>/dev/null || echo "No tmux sessions"`;
      const result = await this.executeCommand(cmd, options);
      const lines = result.stdout.trim().split('\n').filter(line => line && line !== 'No tmux sessions');

      const sessions = lines.map(line => {
        const parts = line.split(',');
        if (parts.length >= 5) {
          return {
            name: parts[0],
            windows: parseInt(parts[1], 10),
            created: new Date(parseInt(parts[2], 10) * 1000).toISOString(),
            flags: parts[3],
            attached: parts[4] === 'attached',
          };
        }
        return { raw: line };
      });

      return {
        sessions,
        count: sessions.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        sessions: [],
        count: 0,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async getTmuxWindows(sessionName: string, options: { host?: string; username?: string; session?: string } = {}): Promise<any> {
    try {
      // Format: index,name,flags,active,last,zoomed
      const cmd = `tmux list-windows -t "${sessionName}" -F "#{window_index},#{window_name},#{window_flags},#{?window_active,true,false},#{?window_last,true,false},#{?window_zoomed_flag,true,false}" 2>/dev/null || echo "Session not found"`;
      const result = await this.executeCommand(cmd, options);

      if (result.stdout.includes('Session not found') || result.stdout.trim() === '') {
        return {
          session: sessionName,
          windows: [],
          count: 0,
          error: 'Session not found or no windows',
          timestamp: new Date().toISOString(),
        };
      }

      const lines = result.stdout.trim().split('\n').filter(line => line);
      const windows = lines.map(line => {
        const parts = line.split(',');
        if (parts.length >= 6) {
          return {
            index: parseInt(parts[0], 10),
            name: parts[1],
            flags: parts[2],
            active: parts[3] === 'true',
            last: parts[4] === 'true',
            zoomed: parts[5] === 'true',
          };
        }
        return { raw: line };
      });

      return {
        session: sessionName,
        windows,
        count: windows.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        session: sessionName,
        windows: [],
        count: 0,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async getTmuxPanes(sessionName: string, windowIndex?: number, options: { host?: string; username?: string; session?: string } = {}): Promise<any> {
    try {
      const target = windowIndex !== undefined ? `${sessionName}:${windowIndex}` : sessionName;
      // Format: index,width,height,history_size,active
      const cmd = `tmux list-panes -t "${target}" -F "#{pane_index},#{pane_width},#{pane_height},#{history_size},#{?pane_active,true,false}" 2>/dev/null || echo "Window not found"`;
      const result = await this.executeCommand(cmd, options);

      if (result.stdout.includes('Window not found') || result.stdout.trim() === '') {
        return {
          session: sessionName,
          window: windowIndex,
          panes: [],
          count: 0,
          error: 'Window not found or no panes',
          timestamp: new Date().toISOString(),
        };
      }

      const lines = result.stdout.trim().split('\n').filter(line => line);
      const panes = lines.map(line => {
        const parts = line.split(',');
        if (parts.length >= 5) {
          return {
            index: parseInt(parts[0], 10),
            size: `${parts[1]}x${parts[2]}`,
            history: parseInt(parts[3], 10),
            active: parts[4] === 'true',
          };
        }
        return { raw: line };
      });

      return {
        session: sessionName,
        window: windowIndex,
        panes,
        count: panes.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        session: sessionName,
        window: windowIndex,
        panes: [],
        count: 0,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async getTmuxInfo(options: { host?: string; username?: string; session?: string } = {}): Promise<any> {
    try {
      const tmuxCheck = await this.executeCommand('which tmux && tmux -V 2>/dev/null || echo "tmux not found"', options);
      let tmuxAvailable = false;
      let version = null;

      if (!tmuxCheck.stdout.includes('tmux not found') && tmuxCheck.stdout.trim()) {
        tmuxAvailable = true;
        const versionMatch = tmuxCheck.stdout.match(/tmux\s+(\d+\.\d+)/);
        if (versionMatch) {
          version = versionMatch[1];
        }
      }

      let serverInfo = null;
      if (tmuxAvailable) {
        try {
          const serverResult = await this.executeCommand('tmux display-message -p "#{version},#{server_sessions},#{server_windows},#{server_panes}" 2>/dev/null || echo "no server"', options);
          if (!serverResult.stdout.includes('no server')) {
            const parts = serverResult.stdout.trim().split(',');
            serverInfo = {
              version: parts[0],
              sessions: parseInt(parts[1], 10) || 0,
              windows: parseInt(parts[2], 10) || 0,
              panes: parseInt(parts[3], 10) || 0,
            };
          }
        } catch (e) {
          // Server info not available
        }
      }

      return {
        available: tmuxAvailable,
        version: version,
        serverInfo: serverInfo,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        available: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // ==================== File Transfer Methods ====================

  /**
   * Transfer file between local and remote host via SFTP
   */
  async transferFile(options: {
    source: string;
    destination: string;
    direction: 'upload' | 'download';
    host: string;
    username: string;
    session?: string;
    overwrite?: boolean;
  }): Promise<{ success: boolean; bytesTransferred: number; message: string }> {
    const { source, destination, direction, host, username, session = 'default', overwrite = false } = options;

    // Validate session name
    this.validateSessionName(session);

    // Validate paths
    if (!source || typeof source !== 'string' || source.trim().length === 0) {
      throw new ValidationError('Source path is required');
    }
    if (!destination || typeof destination !== 'string' || destination.trim().length === 0) {
      throw new ValidationError('Destination path is required');
    }

    // Check for path traversal attempts
    if (this.hasPathTraversal(source) || this.hasPathTraversal(destination)) {
      throw new SecurityError('Path traversal (..) is not allowed in file paths');
    }

    const sessionKey = this.getSessionKey(host, session);

    // Check rate limiting
    this.checkRateLimit(sessionKey);

    // Ensure connection
    await this.connect(host, username, session);
    const sessionData = this.sessions.get(sessionKey);

    if (!sessionData || !sessionData.client) {
      throw new SshConnectionError(`Failed to establish SSH connection to ${host}`);
    }

    // Validate file size for uploads
    if (direction === 'upload') {
      try {
        const stats = fs.statSync(source);
        if (!stats.isFile()) {
          throw new ValidationError(`Source '${source}' is not a file`);
        }
        if (stats.size > this.config.maxFileTransferSize) {
          throw new ResourceLimitError(
            `File size (${stats.size} bytes) exceeds maximum transfer size (${this.config.maxFileTransferSize} bytes). ` +
            `Increase MAX_FILE_TRANSFER_SIZE to allow larger transfers.`
          );
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          throw new ValidationError(`Source file '${source}' does not exist`);
        }
        if (error.code === 'EACCES') {
          throw new ValidationError(`No permission to read source file '${source}'`);
        }
        throw error;
      }
    }

    return new Promise((resolve, reject) => {
      sessionData.client!.sftp((err, sftp) => {
        if (err) {
          reject(new SshConnectionError(`Failed to create SFTP session: ${err.message}`));
          return;
        }

        const transferTimeout = setTimeout(() => {
          sftp.end();
          reject(new TimeoutError('File transfer timed out'));
        }, this.config.connectionTimeout * 2); // Double timeout for file transfers

        if (direction === 'upload') {
          // Upload: local to remote
          const readStream = fs.createReadStream(source);
          
          // Check if destination exists (unless overwrite is true)
          sftp.stat(destination, (statErr) => {
            if (!statErr && !overwrite) {
              clearTimeout(transferTimeout);
              sftp.end();
              reject(new ValidationError(`Destination file '${destination}' already exists. Set overwrite=true to replace.`));
              return;
            }

            const writeStream = sftp.createWriteStream(destination);
            let bytesTransferred = 0;

            readStream.on('data', (chunk) => {
              bytesTransferred += chunk.length;
            });

            readStream.on('error', (readErr) => {
              clearTimeout(transferTimeout);
              sftp.end();
              reject(new CommandExecutionError(`Error reading source file: ${readErr.message}`));
            });

            writeStream.on('error', (writeErr: Error) => {
              clearTimeout(transferTimeout);
              sftp.end();
              reject(new CommandExecutionError(`Error writing to remote file: ${writeErr.message}`));
            });

            writeStream.on('close', () => {
              clearTimeout(transferTimeout);
              sftp.end();
              log.info(`Upload completed: ${source} -> ${host}:${destination} (${bytesTransferred} bytes)`);
              resolve({
                success: true,
                bytesTransferred,
                message: `Successfully uploaded ${source} to ${host}:${destination}`
              });
            });

            readStream.pipe(writeStream);
          });
        } else {
          // Download: remote to local
          // First check remote file size
          sftp.stat(source, (statErr, stats) => {
            if (statErr) {
              clearTimeout(transferTimeout);
              sftp.end();
              if (statErr.message.includes('No such file')) {
                reject(new ValidationError(`Remote file '${source}' does not exist`));
              } else {
                reject(new SshConnectionError(`Failed to stat remote file: ${statErr.message}`));
              }
              return;
            }

            if (stats.size > this.config.maxFileTransferSize) {
              clearTimeout(transferTimeout);
              sftp.end();
              reject(new ResourceLimitError(
                `Remote file size (${stats.size} bytes) exceeds maximum transfer size (${this.config.maxFileTransferSize} bytes). ` +
                `Increase MAX_FILE_TRANSFER_SIZE to allow larger transfers.`
              ));
              return;
            }

            // Check if local destination exists
            if (!overwrite && fs.existsSync(destination)) {
              clearTimeout(transferTimeout);
              sftp.end();
              reject(new ValidationError(`Local destination '${destination}' already exists. Set overwrite=true to replace.`));
              return;
            }

            // Ensure destination directory exists
            const destDir = path.dirname(destination);
            if (!fs.existsSync(destDir)) {
              try {
                fs.mkdirSync(destDir, { recursive: true });
              } catch (mkdirErr: any) {
                clearTimeout(transferTimeout);
                sftp.end();
                reject(new ValidationError(`Failed to create destination directory: ${mkdirErr.message}`));
                return;
              }
            }

            const readStream = sftp.createReadStream(source);
            const writeStream = fs.createWriteStream(destination);
            let bytesTransferred = 0;

            readStream.on('data', (chunk: Buffer) => {
              bytesTransferred += chunk.length;
            });

            readStream.on('error', (readErr: Error) => {
              clearTimeout(transferTimeout);
              sftp.end();
              // Clean up partial file
              try { fs.unlinkSync(destination); } catch (e) { /* ignore */ }
              reject(new CommandExecutionError(`Error reading remote file: ${readErr.message}`));
            });

            writeStream.on('error', (writeErr) => {
              clearTimeout(transferTimeout);
              sftp.end();
              // Clean up partial file
              try { fs.unlinkSync(destination); } catch (e) { /* ignore */ }
              reject(new CommandExecutionError(`Error writing local file: ${writeErr.message}`));
            });

            writeStream.on('close', () => {
              clearTimeout(transferTimeout);
              sftp.end();
              log.info(`Download completed: ${host}:${source} -> ${destination} (${bytesTransferred} bytes)`);
              resolve({
                success: true,
                bytesTransferred,
                message: `Successfully downloaded ${host}:${source} to ${destination}`
              });
            });

            readStream.pipe(writeStream);
          });
        }
      });
    });
  }

  /**
   * Copy file locally (non-SSH)
   */
  async copyFileLocal(options: {
    source: string;
    destination: string;
    overwrite?: boolean;
  }): Promise<{ success: boolean; bytesTransferred: number; message: string }> {
    const { source, destination, overwrite = false } = options;

    // Validate paths
    if (!source || typeof source !== 'string' || source.trim().length === 0) {
      throw new ValidationError('Source path is required');
    }
    if (!destination || typeof destination !== 'string' || destination.trim().length === 0) {
      throw new ValidationError('Destination path is required');
    }

    // Check for path traversal
    if (this.hasPathTraversal(source) || this.hasPathTraversal(destination)) {
      throw new SecurityError('Path traversal (..) is not allowed in file paths');
    }

    // Validate source exists and get size
    let fileSize: number;
    try {
      const stats = fs.statSync(source);
      if (!stats.isFile()) {
        throw new ValidationError(`Source '${source}' is not a file`);
      }
      fileSize = stats.size;
      if (fileSize > this.config.maxFileTransferSize) {
        throw new ResourceLimitError(
          `File size (${fileSize} bytes) exceeds maximum transfer size (${this.config.maxFileTransferSize} bytes).`
        );
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new ValidationError(`Source file '${source}' does not exist`);
      }
      if (error.code === 'EACCES') {
        throw new ValidationError(`No permission to read source file '${source}'`);
      }
      throw error;
    }

    // Check destination
    if (!overwrite && fs.existsSync(destination)) {
      throw new ValidationError(`Destination '${destination}' already exists. Set overwrite=true to replace.`);
    }

    // Ensure destination directory exists
    const destDir = path.dirname(destination);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Copy file
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(source);
      const writeStream = fs.createWriteStream(destination);
      let bytesTransferred = 0;

      readStream.on('data', (chunk) => {
        bytesTransferred += chunk.length;
      });

      readStream.on('error', (err) => {
        try { fs.unlinkSync(destination); } catch (e) { /* ignore */ }
        reject(new CommandExecutionError(`Error reading source file: ${err.message}`));
      });

      writeStream.on('error', (err) => {
        try { fs.unlinkSync(destination); } catch (e) { /* ignore */ }
        reject(new CommandExecutionError(`Error writing destination file: ${err.message}`));
      });

      writeStream.on('close', () => {
        log.info(`Local copy completed: ${source} -> ${destination} (${bytesTransferred} bytes)`);
        resolve({
          success: true,
          bytesTransferred,
          message: `Successfully copied ${source} to ${destination}`
        });
      });

      readStream.pipe(writeStream);
    });
  }
}
