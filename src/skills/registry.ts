import { existsSync, readdirSync } from 'fs';
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

function scanSkillDirectory(dirPath: string, source: SkillSource): SkillMetadata[] {
  if (!existsSync(dirPath)) return [];
  const skills: SkillMetadata[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFilePath = join(dirPath, entry.name, 'SKILL.md');
      if (existsSync(skillFilePath)) {
        skills.push({
          name: entry.name,
          description: `Skill: ${entry.name}`,
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
  return {
    name: metadata.name,
    description: metadata.description,
    instructions: '',
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
