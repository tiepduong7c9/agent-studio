import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import type { SkillRef } from '../../../shared/acp'
import { useToastStore } from '../toast-store'
import { ContextMenu, type MenuItem } from './ContextMenu'
import type { PanelHandle } from './RightPanel'

// Per-session Skills tab (right panel): shows the skills available to the active
// project — its project-level .claude/skills plus the host's personal skills —
// and lets a library skill be injected (copied) into the project. The library
// list is the curated "active" set by default: a scan collects everything on
// every host, most of which is irrelevant to any one project, so only the skills
// marked active in the Skills Manager are offered (with a Show all escape hatch).

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

function matches(s: SkillRef, filter: string): boolean {
  if (!filter) return true
  const f = filter.toLowerCase()
  return s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)
}

interface Props {
  project: ProjectInfo
  filter: string
}

export const SessionSkillsPanel = forwardRef<PanelHandle, Props>(({ project, filter }, ref) => {
  const [available, setAvailable] = useState<SkillRef[]>([])
  const [library, setLibrary] = useState<SkillRef[]>([])
  const [loading, setLoading] = useState(true)
  const [injecting, setInjecting] = useState<string | null>(null)
  // Widen the library list from the active set to everything collected.
  const [showAll, setShowAll] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const pushToast = useToastStore((s) => s.push)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [avail, lib] = await Promise.all([
        window.studio.skills.forProject({ host: project.host ?? null, cwd: project.rootPath }),
        window.studio.skills.list()
      ])
      setAvailable(avail)
      setLibrary(lib.skills)
    } catch {
      setAvailable([])
      setLibrary([])
    } finally {
      setLoading(false)
    }
  }, [project.host, project.rootPath])

  useEffect(() => {
    void load()
  }, [load])

  // The header's refresh button drives this; collapse-all is a no-op here.
  useImperativeHandle(ref, () => ({ refresh: () => void load(), collapseAll: () => {} }), [load])

  const projectSkills = available.filter((s) => s.scope === 'project' && matches(s, filter))
  const personalSkills = available.filter((s) => s.scope === 'host' && matches(s, filter))
  const installed = new Set(available.filter((s) => s.scope === 'project').map((s) => basename(s.dir)))

  const inject = async (skill: SkillRef) => {
    setInjecting(skill.id)
    try {
      const res = await window.studio.skills.inject(project.id, skill.dir)
      if (res.ok) {
        pushToast('info', `Injected "${res.data.name}" into ${project.name}`)
        await load()
      } else {
        pushToast('danger', res.error)
      }
    } finally {
      setInjecting(null)
    }
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      pushToast('info', `Copied ${what}`)
    } catch {
      pushToast('danger', `Could not copy the ${what}`)
    }
  }

  // Right-click menu for a row. Every skill can have its name copied (or copied
  // as an @mention, which is what the composer's autosuggest inserts); library
  // rows additionally toggle Active and inject.
  const rowMenu = (s: SkillRef, inLibrary: boolean): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Copy Name', run: () => void copy(s.name, 'name') },
      { label: 'Copy as @mention', run: () => void copy(`@${s.name}`, 'mention') },
      { label: 'Copy Path', run: () => void copy(s.dir, 'path') }
    ]
    if (inLibrary) {
      const here = installed.has(basename(s.dir))
      items.push(
        { separator: true },
        {
          label: 'Active',
          checked: s.active === true,
          run: () => {
            void window.studio.skills
              .setActive({ dir: s.dir, active: s.active !== true })
              .then(load)
              .catch((err: any) => pushToast('danger', err?.message || String(err)))
          }
        },
        {
          label: here ? 'Update in This Project' : 'Inject into This Project',
          enabled: injecting === null,
          run: () => void inject(s)
        }
      )
    }
    return items
  }

  const openMenu = (e: React.MouseEvent, s: SkillRef, inLibrary: boolean) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(s, inLibrary) })
  }

  const activeLibrary = library.filter((s) => s.active)
  const injectable = (showAll ? library : activeLibrary).filter((s) => matches(s, filter))
  const hiddenCount = library.length - activeLibrary.length

  return (
    <div className="session-skills">
      {loading ? (
        <div className="panel-placeholder">Loading…</div>
      ) : (
        <>
          <div className="skills-sec-label">In this project</div>
          {projectSkills.length === 0 ? (
            <div className="skills-sec-empty">No project skills yet</div>
          ) : (
            projectSkills.map((s) => (
              <div
                key={s.id}
                className="session-skill-row"
                title={s.description || s.name}
                onContextMenu={(e) => openMenu(e, s, false)}
              >
                <span className="codicon codicon-lightbulb session-skill-icon" />
                <div className="session-skill-text">
                  <div className="session-skill-name">{s.name}</div>
                  {s.description && <div className="session-skill-desc">{s.description}</div>}
                </div>
              </div>
            ))
          )}

          {personalSkills.length > 0 && (
            <>
              <div className="skills-sec-label">Personal</div>
              {personalSkills.map((s) => (
                <div
                  key={s.id}
                  className="session-skill-row"
                  title={s.description || s.name}
                  onContextMenu={(e) => openMenu(e, s, false)}
                >
                  <span className="codicon codicon-lightbulb session-skill-icon" />
                  <div className="session-skill-text">
                    <div className="session-skill-name">{s.name}</div>
                    {s.description && <div className="session-skill-desc">{s.description}</div>}
                  </div>
                </div>
              ))}
            </>
          )}

          <div className="skills-sec-label">
            <span>{showAll ? 'Library' : 'Active skills'}</span>
            {hiddenCount > 0 && (
              <button className="skills-sec-toggle" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show active only' : `Show all (${library.length})`}
              </button>
            )}
          </div>
          {injectable.length === 0 ? (
            <div className="skills-sec-empty">
              {library.length === 0
                ? 'Library is empty — collect skills in Customizations → Skills'
                : hiddenCount > 0 && !showAll
                  ? 'No active skills — mark some active in Customizations → Skills'
                  : 'No matching skills'}
            </div>
          ) : (
            injectable.map((s) => {
              const here = installed.has(basename(s.dir))
              return (
                <div
                  key={s.id}
                  className="session-skill-row"
                  title={s.description || s.name}
                  onContextMenu={(e) => openMenu(e, s, true)}
                >
                  <span className="codicon codicon-lightbulb session-skill-icon" />
                  <div className="session-skill-text">
                    <div className="session-skill-name">{s.name}</div>
                    {s.description && <div className="session-skill-desc">{s.description}</div>}
                  </div>
                  <button
                    className="session-skill-inject"
                    onClick={() => void inject(s)}
                    disabled={injecting !== null}
                    title={here ? 'Update the copy in this project' : 'Inject into this project'}
                  >
                    {injecting === s.id ? '…' : here ? 'Update' : 'Inject'}
                  </button>
                </div>
              )
            })
          )}
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
})

SessionSkillsPanel.displayName = 'SessionSkillsPanel'
