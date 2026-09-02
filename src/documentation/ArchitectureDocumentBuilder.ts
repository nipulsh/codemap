import type {
  DocumentBuildOptions,
  GeneratedDocument,
  ProjectArchitecture,
} from './types';

const REQUIRED_HEADINGS = [
  'Project Architecture',
  'Project Summary',
  'Technology Stack',
  'Entry Points',
  'Major Modules',
  'Important Files',
  'Dependency Overview',
  'Architectural Relationships',
  'Known Limitations',
  'Generated Metadata',
];

function formatRoleConfidence(confidence: number): string {
  if (confidence >= 0.8) {
    return 'high';
  }
  if (confidence >= 0.5) {
    return 'medium';
  }
  return 'low';
}

function buildFullMarkdown(
  arch: ProjectArchitecture,
  options: DocumentBuildOptions,
): string {
  const lines: string[] = [];

  lines.push('# Project Architecture', '');
  lines.push('## Project Summary', '', arch.summary, '');

  lines.push('## Technology Stack', '');
  if (arch.technologies.length === 0) {
    lines.push('_No technologies detected from package configuration._', '');
  } else {
    for (const tech of arch.technologies) {
      lines.push(`- ${tech}`);
    }
    lines.push('');
  }

  lines.push('## Entry Points', '');
  if (arch.entryPoints.length === 0) {
    lines.push('_No entry points detected._', '');
  } else {
    for (const ep of arch.entryPoints) {
      lines.push(`- \`${ep.path}\``);
      lines.push(`  - Reason: ${ep.reason}`);
      lines.push(`  - Confidence: ${ep.confidence}`);
      lines.push(`  - Signals: ${ep.signals.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Major Modules', '');
  if (arch.modules.length === 0) {
    lines.push('_No modules detected._', '');
  } else {
    for (const mod of arch.modules) {
      lines.push(`### ${mod.name}`, '');
      lines.push(`- **Path:** \`${mod.path}\``);
      lines.push(`- **Purpose:** ${mod.purpose}`);
      lines.push(
        `- **Role:** ${mod.role.role} (${formatRoleConfidence(mod.role.confidence)} confidence)`,
      );
      if (mod.role.reasons.length > 0) {
        lines.push(`- **Role signals:** ${mod.role.reasons.join('; ')}`);
      }
      lines.push(`- **Files:** ${mod.fileCount}`);
      if (options.includeFunctionDetails && mod.exports.length > 0) {
        lines.push(`- **Exports:** ${mod.exports.join(', ')}`);
      }
      if (mod.dependencies.length > 0) {
        lines.push(`- **Depends on:** ${mod.dependencies.join(', ')}`);
      }
      if (mod.dependents.length > 0) {
        lines.push(`- **Used by:** ${mod.dependents.join(', ')}`);
      }
      lines.push('');
    }
  }

  lines.push('## Important Files', '');
  if (arch.importantFiles.length === 0) {
    lines.push('_No important files ranked._', '');
  } else {
    lines.push('| File | Role | Fan-in | Fan-out | Score |', '| --- | --- | --- | --- | --- |');
    for (const file of arch.importantFiles) {
      lines.push(
        `| \`${file.path}\` | ${file.role.role} | ${file.fanIn} | ${file.fanOut} | ${file.score.toFixed(1)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Dependency Overview', '');
  if (options.includeDependencyGraph === false) {
    lines.push(
      `_Dependency graph omitted (codemap.documentation.includeDependencyGraph = false)._`,
      '',
    );
  } else if (arch.dependencies.length === 0) {
    lines.push('_No internal dependencies detected._', '');
  } else {
    const importDeps = arch.dependencies.filter((d) => d.kind === 'imports');
    lines.push(`Total internal dependency edges: ${importDeps.length}`, '');
    const topDeps = importDeps.slice(0, 30);
    for (const dep of topDeps) {
      lines.push(`- \`${dep.source}\` → \`${dep.target}\` (${dep.kind})`);
    }
    if (importDeps.length > 30) {
      lines.push(`- _… and ${importDeps.length - 30} more_`);
    }
    lines.push('');
  }

  lines.push('## Architectural Relationships', '');
  if (arch.cycles.length > 0) {
    lines.push('### Circular Dependencies', '');
    for (const cycle of arch.cycles) {
      lines.push(`- Files: ${cycle.filePaths.map((p) => `\`${p}\``).join(', ')}`);
    }
    lines.push('');
  } else {
    lines.push('_No circular import dependencies detected._', '');
  }

  if (arch.architecturalRules.length > 0) {
    lines.push('### Architectural Rules', '');
    for (const rule of arch.architecturalRules) {
      lines.push(`- (${rule.source}) ${rule.rule}`);
    }
    lines.push('');
  }

  lines.push('## Known Limitations', '');
  for (const limitation of arch.knownLimitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push('');

  lines.push('## Generated Metadata', '');
  lines.push(`- **Project:** ${arch.projectName}`);
  lines.push(`- **Analyzed files:** ${arch.metadata.fileCount}`);
  lines.push(`- **Modules:** ${arch.metadata.moduleCount}`);
  lines.push(`- **Parse errors:** ${arch.metadata.parseErrorCount}`);
  lines.push(
    `- **TypeScript:** ${arch.metadata.hasTypeScript ? 'yes' : 'no'}`,
  );
  lines.push('- **Generator:** CodeMap Workspace Analysis (Phase 5)');
  lines.push('');

  return lines.join('\n');
}

function buildAgentContext(arch: ProjectArchitecture): string {
  const lines: string[] = [];

  lines.push(`# ${arch.projectName} — Agent Context`, '');
  lines.push('## Project', arch.summary, '');
  lines.push('## Stack', arch.technologies.join(', ') || 'unknown', '');

  lines.push('## Entry Points', '');
  if (arch.entryPoints.length === 0) {
    lines.push('none detected');
  } else {
    for (const ep of arch.entryPoints) {
      lines.push(`- ${ep.path} (${ep.confidence})`);
    }
  }
  lines.push('');

  lines.push('## Critical Modules', '');
  const critical = arch.modules
    .filter((m) => m.role.confidence >= 0.5 || m.fileCount >= 2)
    .slice(0, 10);
  for (const mod of critical) {
    lines.push(`- ${mod.path}: ${mod.role.role} — ${mod.purpose}`);
  }
  lines.push('');

  lines.push('## Important Files', '');
  for (const file of arch.importantFiles.slice(0, 10)) {
    lines.push(
      `- ${file.path} (${file.role.role}, score ${file.score.toFixed(1)})`,
    );
  }
  lines.push('');

  lines.push('## Dependency Constraints', '');
  const topDeps = arch.dependencies.filter((d) => d.kind === 'imports').slice(0, 15);
  for (const dep of topDeps) {
    lines.push(`- ${dep.source} → ${dep.target}`);
  }
  lines.push('');

  lines.push('## Architectural Rules', '');
  for (const rule of arch.architecturalRules) {
    lines.push(`- ${rule.rule}`);
  }
  lines.push('');

  lines.push('## Known Limitations', '');
  for (const lim of arch.knownLimitations) {
    lines.push(`- ${lim}`);
  }

  return lines.join('\n');
}

export function buildArchitectureDocument(
  arch: ProjectArchitecture,
  options: DocumentBuildOptions = {},
): GeneratedDocument {
  const fullMarkdown = buildFullMarkdown(arch, options);
  const agentContext = buildAgentContext(arch);

  return {
    fullMarkdown,
    agentContext: options.agentOptimized === false ? agentContext : agentContext,
  };
}

export function getRequiredHeadings(): string[] {
  return [...REQUIRED_HEADINGS];
}
