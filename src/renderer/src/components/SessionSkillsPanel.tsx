import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import type { SkillRef } from '../../../shared/acp'
import { useToastStore } from '../toast-store'
import type { PanelHandle } from './RightPanel'

// Per-session Skills tab (right panel): shows the skills available to the active
// project — its project-level .claude/skills plus the host's personal skills —
// and lets a library skill be injected (copied) into the project.

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

  const injectable = library.filter((s) => matches(s, filter))

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
              <div key={s.id} className="session-skill-row" title={s.description || s.name}>
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
                <div key={s.id} className="session-skill-row" title={s.description || s.name}>
                  <span className="codicon codicon-lightbulb session-skill-icon" />
                  <div className="session-skill-text">
                    <div className="session-skill-name">{s.name}</div>
                    {s.description && <div className="session-skill-desc">{s.description}</div>}
                  </div>
                </div>
              ))}
            </>
          )}

          <div className="skills-sec-label">Library</div>
          {injectable.length === 0 ? (
            <div className="skills-sec-empty">Library is empty — collect skills in Customizations → Skills</div>
          ) : (
            injectable.map((s) => {
              const here = installed.has(basename(s.dir))
              return (
                <div key={s.id} className="session-skill-row" title={s.description || s.name}>
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
    </div>
  )
})

SessionSkillsPanel.displayName = 'SessionSkillsPanel'
