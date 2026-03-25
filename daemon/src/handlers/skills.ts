import * as os from 'os';
import { HandlerContext, MessageHandler } from '../handler-context';
import { scanProjectSkills, scanGlobalSkills } from '../skill-scanner';
import { templates as scaffoldTemplates } from '../scaffold/templates';
import { scaffoldProject, previewScaffold } from '../scaffold/generator';
import { ProjectConfig } from '../scaffold/types';
import { scoreTemplates } from '../scaffold/scorer';

export function registerSkillHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    list_skills(client, _payload, requestId) {
      try {
        const listPayload = _payload as { sessionId?: string } | undefined;
        const projectRoot = ctx.getProjectRoot(listPayload?.sessionId);
        const projectSkills = projectRoot ? scanProjectSkills(projectRoot) : [];
        const globalSkills = scanGlobalSkills();

        const catalogSkills = ctx.skillCatalog.getAvailableSkills();

        const installedIds = new Set([
          ...projectSkills.map((s) => s.id),
          ...globalSkills.map((s) => s.id),
        ]);

        const enrichInstalled = (s: { id: string; name: string; description: string; source: string }) => {
          const catalogEntry = ctx.skillCatalog.getSkill(s.id);
          if (catalogEntry) {
            return {
              id: s.id,
              name: s.name,
              description: s.description,
              category: catalogEntry.category,
              scope: catalogEntry.scope,
              prerequisites: catalogEntry.prerequisites,
              installed: true,
              source: s.source,
            };
          }
          return {
            id: s.id,
            name: s.name,
            description: s.description,
            category: 'custom',
            scope: 'universal' as const,
            installed: true,
            source: s.source,
          };
        };

        const skills = [
          ...projectSkills.map(enrichInstalled),
          ...globalSkills
            .filter((s) => !projectSkills.some((p) => p.id === s.id))
            .map(enrichInstalled),
          ...catalogSkills
            .filter((s) => !installedIds.has(s.id))
            .map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              category: s.category,
              scope: s.scope,
              installed: false,
              source: 'catalog' as const,
            })),
        ];

        ctx.send(client.ws, {
          type: 'skills_list',
          success: true,
          payload: { skills },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'skills_list',
          success: false,
          error: String(err),
          requestId,
        });
      }
    },

    install_skill(client, payload, requestId) {
      try {
        const installPayload = payload as { skillId: string; target: 'project' | 'global'; sessionId?: string } | undefined;
        if (!installPayload?.skillId) {
          ctx.send(client.ws, {
            type: 'skill_installed',
            success: false,
            error: 'Missing skillId',
            requestId,
          });
          return;
        }

        const projectRoot = ctx.getProjectRoot(installPayload.sessionId) || os.homedir();
        ctx.skillCatalog.installSkill(installPayload.skillId, installPayload.target, projectRoot);

        ctx.send(client.ws, {
          type: 'skill_installed',
          success: true,
          payload: { skillId: installPayload.skillId, target: installPayload.target },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'skill_installed',
          success: false,
          error: String(err),
          requestId,
        });
      }
    },

    uninstall_skill(client, payload, requestId) {
      try {
        const uninstallPayload = payload as { skillId: string; source: 'project' | 'global'; sessionId?: string } | undefined;
        if (!uninstallPayload?.skillId) {
          ctx.send(client.ws, {
            type: 'skill_uninstalled',
            success: false,
            error: 'Missing skillId',
            requestId,
          });
          return;
        }

        const projectRoot = ctx.getProjectRoot(uninstallPayload.sessionId) || os.homedir();
        ctx.skillCatalog.uninstallSkill(uninstallPayload.skillId, uninstallPayload.source, projectRoot);

        ctx.send(client.ws, {
          type: 'skill_uninstalled',
          success: true,
          payload: { skillId: uninstallPayload.skillId },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'skill_uninstalled',
          success: false,
          error: String(err),
          requestId,
        });
      }
    },

    get_skill_content(client, payload, requestId) {
      const contentPayload = payload as { skillId: string } | undefined;
      if (!contentPayload?.skillId) {
        ctx.send(client.ws, {
          type: 'skill_content',
          success: false,
          error: 'Missing skillId',
          requestId,
        });
        return;
      }

      const content = ctx.skillCatalog.getSkillContent(contentPayload.skillId);
      if (content) {
        ctx.send(client.ws, {
          type: 'skill_content',
          success: true,
          payload: { skillId: contentPayload.skillId, content },
          requestId,
        });
      } else {
        ctx.send(client.ws, {
          type: 'skill_content',
          success: false,
          error: `Skill not found: ${contentPayload.skillId}`,
          requestId,
        });
      }
    },

    get_scaffold_templates(client, payload, requestId) {
      const scaffoldPayload = payload as { description?: string } | undefined;
      const description = scaffoldPayload?.description;

      if (description && description.trim()) {
        const scores = scoreTemplates(scaffoldTemplates, description);
        const scoreMap = new Map(scores.map((s) => [s.templateId, s]));

        const sorted = [...scaffoldTemplates].sort((a, b) => {
          const sa = scoreMap.get(a.id)?.score ?? 0;
          const sb = scoreMap.get(b.id)?.score ?? 0;
          return sb - sa;
        });

        ctx.send(client.ws, {
          type: 'scaffold_templates',
          success: true,
          payload: {
            templates: sorted.map((t) => {
              const s = scoreMap.get(t.id);
              return {
                id: t.id,
                name: t.name,
                description: t.description,
                type: t.type,
                icon: t.icon,
                tags: t.tags,
                fileCount: t.files.length,
                score: s?.score ?? 0,
                matchedKeywords: s?.matchedKeywords ?? [],
              };
            }),
          },
          requestId,
        });
      } else {
        ctx.send(client.ws, {
          type: 'scaffold_templates',
          success: true,
          payload: {
            templates: scaffoldTemplates.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              type: t.type,
              icon: t.icon,
              tags: t.tags,
              fileCount: t.files.length,
            })),
          },
          requestId,
        });
      }
    },

    async scaffold_preview(client, payload, requestId) {
      const previewConfig = payload as ProjectConfig;
      const previewResult = await previewScaffold(previewConfig);
      ctx.send(client.ws, {
        type: 'scaffold_preview',
        success: !('error' in previewResult),
        payload: previewResult,
        requestId,
      });
    },

    async scaffold_create(client, payload, requestId) {
      try {
        const createConfig = payload as ProjectConfig;
        console.log(
          'Scaffold: Creating project',
          createConfig.name,
          'at',
          createConfig.location
        );
        const createResult = await scaffoldProject(createConfig, (progress) => {
          console.log('Scaffold progress:', progress.step, progress.detail || '');
          ctx.send(client.ws, {
            type: 'scaffold_progress',
            success: true,
            payload: progress,
          });
        });
        console.log('Scaffold result:', createResult.success ? 'success' : createResult.error);
        ctx.send(client.ws, {
          type: 'scaffold_result',
          success: createResult.success,
          payload: createResult,
          requestId,
        });
      } catch (err) {
        console.error('Scaffold error:', err);
        ctx.send(client.ws, {
          type: 'scaffold_result',
          success: false,
          error: err instanceof Error ? err.message : String(err),
          requestId,
        });
      }
    },
  };
}
