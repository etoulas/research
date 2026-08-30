# Research projects carried out by AI tools

Each directory in this repo is a separate research project carried out by an LLM tool - usually [Claude Code](https://www.claude.com/product/claude-code). Every single line of text and code was written by an LLM.

This repo follows the pattern described in [Code research projects with async coding agents like Claude Code and Codex](https://simonwillison.net/2025/Nov/6/async-code-research/).

Prompts and links to transcripts are included in [the PRs](https://github.com/etoulas/research/pulls?q=is%3Apr+is%3Aclosed) that added each report, or in [the commits](https://github.com/etoulas/research/commits/main/).

*Times shown are in UTC.*

<!--[[[cog
import os
import re
import subprocess
import pathlib
from datetime import datetime, timezone

# Model used to generate project summaries
MODEL = "anthropic/claude-opus-5"

# Get all subdirectories with their first README commit dates
research_dir = pathlib.Path.cwd()
subdirs_with_dates = []

for d in research_dir.iterdir():
    # Skip dotdirs, underscore-prefixed dirs (__pycache__, _site) and node_modules -
    # cog walks the filesystem, not git, so untracked dirs would otherwise be indexed
    if d.is_dir() and not d.name.startswith(('.', '_')) and d.name != 'node_modules':
        readme_path = d / "README.md"
        history_path = str(readme_path.relative_to(research_dir))
        # Get the date of the first commit that touched this project's README
        try:
            result = subprocess.run(
                ['git', 'log', '--follow', '--format=%aI', '--reverse', '--', history_path],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                # Oldest commit that touched this README
                date_str = result.stdout.strip().splitlines()[0]
                commit_date = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
                subdirs_with_dates.append((d.name, commit_date))
            else:
                # No git history, use README modification time if available
                fallback_path = readme_path if readme_path.exists() else d
                subdirs_with_dates.append((d.name, datetime.fromtimestamp(fallback_path.stat().st_mtime, tz=timezone.utc)))
        except Exception:
            # Fallback to README modification time if available
            fallback_path = readme_path if readme_path.exists() else d
            subdirs_with_dates.append((d.name, datetime.fromtimestamp(fallback_path.stat().st_mtime, tz=timezone.utc)))

# Print the heading with count
print(f"## {len(subdirs_with_dates)} research projects\n")

# Sort by date, most recent first
subdirs_with_dates.sort(key=lambda x: x[1], reverse=True)

for dirname, commit_date in subdirs_with_dates:
    folder_path = research_dir / dirname
    readme_path = folder_path / "README.md"
    summary_path = folder_path / "_summary.md"

    date_formatted = commit_date.astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M')

    # Get GitHub repo URL
    github_url = None
    try:
        result = subprocess.run(
            ['git', 'remote', 'get-url', 'origin'],
            capture_output=True,
            text=True,
            timeout=2
        )
        if result.returncode == 0 and result.stdout.strip():
            origin = result.stdout.strip()
            # Convert SSH URL to HTTPS URL for GitHub
            if origin.startswith('git@github.com:'):
                origin = origin.replace('git@github.com:', 'https://github.com/')
            if origin.endswith('.git'):
                origin = origin[:-4]
            github_url = f"{origin}/tree/main/{dirname}"
    except Exception:
        pass

    # Extract title from first H1 header in README, fallback to dirname
    title = dirname
    if readme_path.exists():
        with open(readme_path, 'r') as f:
            for readme_line in f:
                if readme_line.startswith('# '):
                    title = readme_line[2:].strip()
                    break

    if github_url:
        print(f"### [{title}]({github_url}#readme) ({date_formatted})\n")
    else:
        print(f"### {title} ({date_formatted})\n")

    # Check if summary already exists
    if summary_path.exists():
        # Use cached summary
        with open(summary_path, 'r') as f:
            description = f.read().strip()
            if description:
                print(description)
            else:
                print("*No description available.*")
    elif readme_path.exists():
        # Generate new summary using llm command
        prompt = """Summarize this research project concisely. Write just 1 paragraph (3-5 sentences) followed by an optional short bullet list if there are key findings. Vary your opening - don't start with "This report" or "This research". Include 1-2 links to key tools/projects. Be specific but brief. No emoji."""
        result = subprocess.run(
            ['llm', '-m', MODEL, '-s', prompt],
            stdin=open(readme_path),
            capture_output=True,
            text=True,
            timeout=60
        )
        if result.returncode != 0:
            error_msg = f"LLM command failed for {dirname} with return code {result.returncode}"
            if result.stderr:
                error_msg += f"\nStderr: {result.stderr}"
            raise RuntimeError(error_msg)
        if result.stdout.strip():
            description = result.stdout.strip()
            print(description)
            # Save to cache file
            with open(summary_path, 'w') as f:
                f.write(description + '\n')
        else:
            raise RuntimeError(f"LLM command returned no output for {dirname}")
    else:
        print("*No description available.*")

    print()  # Add blank line between entries

# Add AI-generated note to all project README.md files
# Note: we construct these marker strings via concatenation to avoid the HTML comment close sequence
AI_NOTE_START = "<!-- AI-GENERATED-NOTE --" + ">"
AI_NOTE_END = "<!-- /AI-GENERATED-NOTE --" + ">"
AI_NOTE_CONTENT = """> [!NOTE]
> This is an AI-generated research report. All text and code in this report was created by an LLM (Large Language Model). For more information on how these reports are created, see the [main research repository](https://github.com/etoulas/research)."""

NOT_AI_GENERATED = "<!-- not-ai-generated --" + ">"

for dirname, _ in subdirs_with_dates:
    folder_path = research_dir / dirname
    readme_path = folder_path / "README.md"

    if not readme_path.exists():
        continue

    content = readme_path.read_text()

    # Skip files marked as not AI-generated
    if NOT_AI_GENERATED in content:
        continue

    # Check if note already exists
    if AI_NOTE_START in content:
        # Replace existing note
        pattern = re.escape(AI_NOTE_START) + r'.*?' + re.escape(AI_NOTE_END)
        new_note = f"{AI_NOTE_START}\n{AI_NOTE_CONTENT}\n{AI_NOTE_END}"
        new_content = re.sub(pattern, new_note, content, flags=re.DOTALL)
        if new_content != content:
            readme_path.write_text(new_content)
    else:
        # Add note after first heading (# ...)
        lines = content.split('\n')
        new_lines = []
        note_added = False
        for i, line in enumerate(lines):
            new_lines.append(line)
            if not note_added and line.startswith('# '):
                # Add blank line, then note, then blank line
                new_lines.append('')
                new_lines.append(AI_NOTE_START)
                new_lines.append(AI_NOTE_CONTENT)
                new_lines.append(AI_NOTE_END)
                note_added = True

        if note_added:
            readme_path.write_text('\n'.join(new_lines))

]]]-->
## 1 research projects

### [3D Stroke Type](https://github.com/etoulas/research/tree/main/3d-text-lighting#readme) (2026-08-30 19:25)

A browser toy that types text as extruded 3D letters, built entirely from a hand-authored stroke font and a single 2D canvas — no WebGL, no font files, roughly 600 lines of JavaScript. Each glyph is a builder function parameterized by cap height (in grid squares) and stroke width, with centre lines placed so that stroke edges land exactly on grid intersections; straight strokes are used wherever a letter permits, arcs only where the shape demands them (S, O, C, G, Q, U, most digits). Chains are offset along angle bisectors, extruded into prisms with analytic per-face normals, back-face culled, and drawn with a painter's algorithm under a point light with ambient/Lambert/Blinn shading. Shadows come from projecting each prism's eight corners onto a floor plane and compositing the convex hulls once through an offscreen canvas, so overlaps stay soft rather than stacking to black. The [live demo](https://etoulas.github.io/research/3d-text-lighting/) exposes depth, stroke, cap height, light distance, intensity and softness as knobs, plus a draggable sun and orbiting camera.

- Grid alignment is verified programmatically, not by eye: axis-aligned glyphs across 20 cap-height × stroke-width combinations assert every prism vertex hits a lattice point, with worst error 3.6e-15 squares.
- The first verification run caught a real bug — degenerate chains for `.` and `:` were nudged into stubs, putting 12 vertices off by 1e-4.
- Screen-drag to world-space light movement uses a numerically built 2×2 Jacobian of the projection, inverted and iterated Newton-style; the lamp is stored as a canvas fraction so it survives view refits.
- Grid sizing needs an inverse projection onto a constant-z plane, which reduces in closed form to a 2×2 linear system solved at the canvas corners.
- Known gaps: letters don't shadow each other, the font is caps-only, and diagonals/curves can only be pinned at endpoints and extremes.

<!--[[[end]]]-->

---

## Updating this README

This README uses [cogapp](https://nedbatchelder.com/code/cog/) to automatically generate project descriptions, with summaries written by the [Claude API](https://docs.claude.com/en/api/) via [LLM](https://llm.datasette.io/) and [llm-anthropic](https://github.com/simonw/llm-anthropic).

### Automatic updates

A GitHub Action runs `cog -r -P README.md` on every push to `main` and commits any changes to the README or new `_summary.md` files. It needs an `ANTHROPIC_API_KEY` repository secret.

### Manual updates

To update locally, with `ANTHROPIC_API_KEY` set in your environment:

```bash
uvx --with llm --with llm-anthropic --from cogapp cog -r -P README.md
```

The script automatically:
- Discovers all subdirectories in this folder
- Gets the first commit date that touched each folder's `README.md` and sorts by date, newest first
- For each folder, checks if a `_summary.md` file exists
- If the summary exists, it uses the cached version
- If not, it generates a new summary with `llm -m <!--[[[cog
print(MODEL, end='')
]]]-->
anthropic/claude-opus-5
<!--[[[end]]]-->`
- Creates markdown links to each project folder on GitHub
- New summaries are saved to `_summary.md` to avoid regenerating them on every run

To regenerate a specific project's description, delete its `_summary.md` file and run cog again.
