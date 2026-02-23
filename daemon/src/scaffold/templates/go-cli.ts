import { StackTemplate } from '../types';

export const goCliTemplate: StackTemplate = {
  id: 'go-cli',
  name: 'Go CLI Tool',
  description: 'Cross-platform command-line tool with Cobra and structured logging',
  type: 'cli',
  icon: '🔷',
  tags: ['go', 'golang', 'cli', 'cobra', 'command-line'],
  scoring: {
    primaryKeywords: ['go', 'golang', 'cobra', 'cli'],
    secondaryKeywords: ['command', 'terminal', 'tool', 'binary', 'cross-platform', 'flag'],
    useCases: ['go cli tool', 'command line tool', 'go command line', 'cli utility', 'go binary'],
    typeSignals: { cli: 3, tool: 2, command: 2, terminal: 2, binary: 1 },
  },
  files: [
    {
      path: 'go.mod',
      template: `module {{projectName}}

go 1.22

require (
\tgithub.com/spf13/cobra v1.8.0
)

require (
\tgithub.com/inconshreveable/mousetrap v1.1.0 // indirect
\tgithub.com/spf13/pflag v1.0.5 // indirect
)`,
    },
    {
      path: 'main.go',
      template: `package main

import "{{projectName}}/cmd"

func main() {
\tcmd.Execute()
}`,
    },
    {
      path: 'cmd/root.go',
      template: `package cmd

import (
\t"fmt"
\t"os"

\t"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
\tUse:   "{{projectName}}",
\tShort: "{{projectDescription}}",
\tLong:  "{{projectDescription}}",
}

func Execute() {
\tif err := rootCmd.Execute(); err != nil {
\t\tfmt.Fprintln(os.Stderr, err)
\t\tos.Exit(1)
\t}
}

func init() {
\trootCmd.PersistentFlags().BoolP("verbose", "v", false, "verbose output")
}`,
    },
    {
      path: 'cmd/version.go',
      template: `package cmd

import (
\t"fmt"

\t"github.com/spf13/cobra"
)

var (
\tVersion   = "dev"
\tCommit    = "none"
\tBuildDate = "unknown"
)

var versionCmd = &cobra.Command{
\tUse:   "version",
\tShort: "Print version information",
\tRun: func(cmd *cobra.Command, args []string) {
\t\tfmt.Printf("{{projectName}} %s (commit: %s, built: %s)\\n", Version, Commit, BuildDate)
\t},
}

func init() {
\trootCmd.AddCommand(versionCmd)
}`,
    },
    {
      path: 'cmd/run.go',
      template: `package cmd

import (
\t"fmt"

\t"github.com/spf13/cobra"
)

var runCmd = &cobra.Command{
\tUse:   "run",
\tShort: "Run the main command",
\tRunE: func(cmd *cobra.Command, args []string) error {
\t\tverbose, _ := cmd.Flags().GetBool("verbose")
\t\tif verbose {
\t\t\tfmt.Println("Running in verbose mode...")
\t\t}
\t\tfmt.Println("Hello from {{projectName}}!")
\t\treturn nil
\t},
}

func init() {
\trootCmd.AddCommand(runCmd)
}`,
    },
    {
      path: 'Makefile',
      template: `BINARY_NAME={{projectName}}
VERSION?=dev
COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
BUILD_DATE=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS=-ldflags "-X {{projectName}}/cmd.Version=$(VERSION) -X {{projectName}}/cmd.Commit=$(COMMIT) -X {{projectName}}/cmd.BuildDate=$(BUILD_DATE)"

.PHONY: build run test clean

build:
\tgo build $(LDFLAGS) -o bin/$(BINARY_NAME) .

run:
\tgo run . run

test:
\tgo test ./... -v

clean:
\trm -rf bin/

install:
\tgo install $(LDFLAGS) .`,
    },
    {
      path: '.gitignore',
      template: `# Binaries
bin/
*.exe
*.exe~
*.dll
*.so
*.dylib

# Test
*.test
*.out
coverage.out

# Vendor
vendor/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store`,
    },
    {
      path: 'CLAUDE.md',
      template: `# {{projectName}}

{{projectDescription}}

## Tech Stack
- Go 1.22+
- Cobra for CLI framework
- Make for build automation

## Project Structure
\`\`\`
├── main.go           # Entry point
├── cmd/
│   ├── root.go       # Root command and global flags
│   ├── version.go    # Version command
│   └── run.go        # Main run command
├── Makefile          # Build targets
└── go.mod            # Go module definition
\`\`\`

## Commands
- \`make build\` - Build binary to bin/
- \`make run\` - Run directly with go run
- \`make test\` - Run tests
- \`make install\` - Install globally
- \`go run . version\` - Print version

## Development Notes
- Add new subcommands in \`cmd/\`
- Use \`rootCmd.PersistentFlags()\` for global flags
- Use \`cmd.Flags()\` for command-specific flags
- Build with version info: \`make build VERSION=1.0.0\`

## Dispatch Mode (Subagents)
- Use the Task tool for independent, parallelizable work (exploration, research, tests)
- Keep the main thread for orchestration and user-facing communication
- Launch multiple agents in parallel when tasks don't depend on each other
- Give agents descriptive prompts — the description shows in the Companion dispatch panel`,
    },
    {
      path: '.claude/settings.json',
      template: `{
  "permissions": {
    "allow": [
      "Bash",
      "Edit",
      "Write",
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "Task",
      "NotebookEdit"
    ],
    "defaultMode": "bypassPermissions"
  }
}`,
    },
    {
      path: 'README.md',
      template: `# {{projectName}}

{{projectDescription}}

## Install

\`\`\`bash
go install {{projectName}}@latest
\`\`\`

## Usage

\`\`\`bash
{{projectName}} run
{{projectName}} version
{{projectName}} --help
\`\`\`

## Build from source

\`\`\`bash
make build
./bin/{{projectName}} run
\`\`\``,
    },
  ],
  postCreate: [
    {
      command: 'go mod tidy',
      description: 'Downloading Go dependencies',
    },
  ],
  recommendedSkills: ['build', 'test'],
};
