import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SkillMetadata, Skill, SkillSource } from './types.js';
import { dexterPath } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_DIRECTORIES: { path: string; source: SkillSource }[] = [
  { path: __dirname, source: 'builtin' },
  { path: join(process.cwd(), dexterPath('skills')), source: 'project' },
];

let skillMetadataCache: Map<string, SkillMetadata> | null = null;

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, no dependencies)
// ---------------------------------------------------------------------------

interface FrontmatterResult {
  data: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): FrontmatterResult {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { data: {}, body: content };
  }
  const end = trimmed.indexOf('---', 3);
  if (end === -1) {
    return { data: {}, body: content };
  }
  const yamlBlock = trimmed.slice(3, end);
  const body = trimmed.slice(end + 3).trimStart();

  // Parse YAML lines, merging continuation lines (indented or lines without a colon)
  const data: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue = '';
  for (const line of yamlBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon !== -1 && (line[0] !== ' ' && line[0] !== '\t')) {
      // New key — flush previous
      if (currentKey) data[currentKey] = currentValue.trim();
      currentKey = line.slice(0, colon).trim();
      let val = line.slice(colon + 1).trim();
      if (val === '>') val = '';
      currentValue = val;
    } else if (currentKey) {
      // Continuation line
      currentValue += ' ' + line.trim();
    }
  }
  if (currentKey) data[currentKey] = currentValue.trim();

  return { data, body };
}

// ---------------------------------------------------------------------------
// Skill discovery & loading
// ---------------------------------------------------------------------------

function scanSkillDirectory(dirPath: string, source: SkillSource): SkillMetadata[] {
  if (!existsSync(dirPath)) return [];
  const skills: SkillMetadata[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFilePath = join(dirPath, entry.name, 'SKILL.md');
      if (existsSync(skillFilePath)) {
        const raw = readFileSync(skillFilePath, 'utf-8');
        const { data } = parseFrontmatter(raw);
        skills.push({
          name: data.name || entry.name,
          description: data.description || `Skill: ${entry.name}`,
          path: skillFilePath,
          source,
        });
      }
    }
  }
  return skills;
}

export function discoverSkills(): SkillMetadata[] {
  if (skillMetadataCache) return Array.from(skillMetadataCache.values());

  skillMetadataCache = new Map();
  for (const { path, source } of SKILL_DIRECTORIES) {
    const skills = scanSkillDirectory(path, source);
    for (const skill of skills) {
      skillMetadataCache.set(skill.name, skill);
    }
  }
  return Array.from(skillMetadataCache.values());
}

export function getSkill(name: string): Skill | undefined {
  if (!skillMetadataCache) discoverSkills();
  const metadata = skillMetadataCache?.get(name);
  if (!metadata) return undefined;

  // Read the full SKILL.md to get instructions (body after frontmatter)
  let instructions = '';
  try {
    const raw = readFileSync(metadata.path, 'utf-8');
    const { body } = parseFrontmatter(raw);
    instructions = body;
  } catch {
    // If file can't be read, return empty instructions
  }

  return {
    name: metadata.name,
    description: metadata.description,
    instructions,
    source: metadata.source,
    path: metadata.path,
  };
}

export function buildSkillMetadataSection(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return 'No skills available.';
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n');
}

export function clearSkillCache(): void {
  skillMetadataCache = null;
}
