# Skill Seekers MCP Server

An MCP server that generates Claude Code skills from documentation websites, GitHub repositories, and PDF files.

## Installation

### Option 1: Add to Claude Code

```bash
claude mcp add --transport http skill-seekers https://skill-seekers.apify.actor/mcp \
  --header "Authorization: Bearer YOUR_APIFY_TOKEN"
```

For cloud skill creation, add your Anthropic API key:

```bash
claude mcp add --transport http skill-seekers https://skill-seekers.apify.actor/mcp \
  --header "Authorization: Bearer YOUR_APIFY_TOKEN" \
  --header "X-Anthropic-Api-Key: YOUR_ANTHROPIC_API_KEY"
```

### Option 2: Run Locally

```bash
npm install
npm run build
npm start
```

## Available Tools

### `estimate_pages`
Preview how many pages will be scraped before starting.

```
url: "https://docs.example.com"
```

### `scrape_docs`
Scrape a documentation website and generate a skill.

```
config: {
  name: "my-skill",
  description: "Skill description",
  baseUrl: "https://docs.example.com"
}
```

### `scrape_github`
Scrape a GitHub repository (README, issues, releases).

```
repo: "facebook/react"
name: "react"
description: "React framework"
```

### `scrape_pdf`
Extract content from a PDF file.

```
pdfUrl: "https://example.com/docs.pdf"
name: "my-pdf-skill"
```

### `get_job_status`
Check progress of a scraping job.

```
jobId: "job-abc123"
```

### `list_jobs`
List all scraping jobs.

### `list_skills`
List all generated skills.

### `get_skill`
Get details and download URL for a skill.

```
skillId: "skill-react-abc123"
```

### `list_configs`
List preset configurations for popular frameworks.

### `install_skill`
Install a skill to your local machine or cloud.

```
skillId: "skill-react-abc123"
skillType: "personal"  # or "project" or "cloud"
```

### `validate_config`
Validate a configuration before scraping.

```
config: {
  name: "my-skill",
  description: "...",
  baseUrl: "https://docs.example.com"
}
```

### `split_config`
Split large documentation (5000+ pages) into multiple focused skills.

```
config: { name: "godot", baseUrl: "https://docs.godotengine.org", ... }
targetPagesPerSkill: 2000
```

### `generate_router`
Generate a router skill that directs users to the right sub-skill.

```
name: "godot-router"
description: "Godot game engine documentation"
subSkills: [
  { name: "godot-core", description: "Core APIs", topics: ["Node", "Scene"] },
  { name: "godot-3d", description: "3D rendering", topics: ["Mesh", "Camera"] }
]
```

## Skill Types

| Type | Location | Use Case |
|------|----------|----------|
| `personal` | `~/.claude/skills/` | Your own use across all projects |
| `project` | `.claude/skills/` | Share with team via git |
| `cloud` | Anthropic account | Available everywhere |

## Generated Skill Structure

```
my-skill/
├── SKILL.md           (required)
├── reference.md       (optional documentation)
├── examples.md        (optional examples)
├── scripts/
│   └── helper.py      (optional utility)
└── templates/
    └── template.txt   (optional template)
```

## Usage Examples

### Create a skill from React docs

1. Start scraping:
   ```
   scrape_docs(config: {
     name: "react",
     description: "React framework",
     baseUrl: "https://react.dev/learn"
   })
   ```

2. Check progress:
   ```
   get_job_status(jobId: "job-xxx")
   ```

3. Install when complete:
   ```
   install_skill(skillId: "skill-react-xxx", skillType: "personal")
   ```

### Create a skill from a GitHub repo

```
scrape_github(repo: "expressjs/express", name: "express")
```

### Create a skill from a PDF

```
scrape_pdf(pdfUrl: "https://example.com/api-docs.pdf", name: "api-docs")
```

### Handle large documentation (10K+ pages)

1. Split into sub-skills:
   ```
   split_config(config: {
     name: "godot",
     description: "Godot game engine",
     baseUrl: "https://docs.godotengine.org"
   }, targetPagesPerSkill: 2000)
   ```

2. Scrape each sub-config returned

3. Generate router:
   ```
   generate_router(
     name: "godot-router",
     description: "Godot documentation",
     subSkills: [...]
   )
   ```

4. Install all skills including the router

## Preset Configurations

Use `list_configs` to see available presets for:
- React
- Vue
- Django
- FastAPI
- Tailwind CSS
