# Contributing to Terminal MCP Server

Thank you for your interest in contributing to the Terminal MCP Server! This document provides guidelines for contributing to this project.

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Security Considerations](#security-considerations)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)

## Ways to Contribute

### Code Contributions
- **Bug fixes**: Fix issues in command execution, SSH connections, or session management
- **New features**: Add new terminal capabilities, session features, or remote execution options
- **Performance improvements**: Optimize command execution or connection handling
- **Documentation**: Improve documentation and examples

### Testing & Quality
- **Bug reports**: Report issues with detailed reproduction steps
- **Test coverage**: Add or improve test cases
- **Security testing**: Test command injection prevention and access controls

### Documentation
- **README updates**: Keep documentation current
- **Examples**: Provide usage examples and tutorials
- **Security guidelines**: Document security best practices

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Hela-Ecosystem/terminal-mcp.git
   cd terminal-mcp
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the project**:
   ```bash
   npm run build
   ```

4. **Start development server**:
   ```bash
   npm run dev
   ```

## Development Workflow

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** and ensure tests pass:
   ```bash
   npm test
   ```

3. **Run linting**:
   ```bash
   npm run lint
   ```

4. **Build the project**:
   ```bash
   npm run build
   ```

5. **Commit your changes**:
   ```bash
   git commit -m "Add: brief description of your changes"
   ```

6. **Push to your branch**:
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request**

## Coding Standards

### General Guidelines
- Follow TypeScript best practices
- Handle command execution securely
- Implement proper input validation and sanitization
- Add comprehensive error handling
- Respect system security and permissions

### Code Style
- Use 2 spaces for indentation
- Use single quotes for strings
- Use semicolons
- Follow the existing code patterns
- Use ESLint configuration

### Commit Messages
- Use conventional commit format: `type: description`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
- Keep first line under 50 characters
- Add detailed description for complex changes

## Testing

### Running Tests
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Writing Tests
- Add unit tests for new command features
- Add integration tests for command execution
- Test error conditions and edge cases
- Test with different command types and permissions
- Maintain high test coverage

## Security Considerations

### Command Execution Security
- **Never execute user input directly**
- **Validate and sanitize all command inputs**
- **Use allowlists for permitted commands**
- **Implement proper timeouts**
- **Log security-relevant events**

### SSH Security
- **Validate SSH host keys**
- **Use secure authentication methods**
- **Implement connection timeouts**
- **Handle SSH errors gracefully**
- **Never log sensitive credentials**

### Input Validation
- **Validate all user inputs**
- **Prevent command injection attacks**
- **Use parameterized commands when possible**
- **Implement rate limiting**
- **Monitor for suspicious activity**

## Pull Request Process

1. **Ensure all tests pass**
2. **Update documentation** if needed
3. **Add tests** for new features
4. **Follow coding standards**
5. **Write clear commit messages**
6. **Verify security implications**

### PR Checklist
- [ ] Tests pass
- [ ] Code is linted
- [ ] Documentation updated
- [ ] Security review completed
- [ ] No sensitive data logged
- [ ] Input validation implemented
- [ ] Commit messages follow conventions
- [ ] PR description is clear
- [ ] Breaking changes documented

## Reporting Issues

### Bug Reports
Please include:
- **Steps to reproduce**: Detailed steps
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Environment**: OS, Node.js version, shell type
- **Command details**: The command that was executed
- **Logs**: Any relevant error messages (without sensitive data)

### Feature Requests
Please include:
- **Use case**: Why this feature is needed
- **Proposed solution**: How it should work
- **Security impact**: How it affects security
- **Alternatives considered**: Other approaches

### Security Issues
- **Do not report security issues publicly**
- **Contact maintainers directly** for security concerns
- **Command injection** or **credential exposure** should be reported privately

## Getting Help

- **Issues**: Use GitHub issues for bugs and features
- **Discussions**: Join community discussions
- **Documentation**: Check the README and docs folder

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
