import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

const FORMATS = [
  { value: 'mp4', label: 'Vídeo → MP4' },
  { value: 'avi', label: 'Vídeo → AVI' },
  { value: 'wav', label: 'Áudio → WAV' },
  { value: 'mp3', label: 'Áudio → MP3' },
  { value: 'png', label: 'Imagem → PNG' },
  { value: 'jpeg', label: 'Imagem → JPEG' },
  { value: 'webp', label: 'Imagem → WebP' },
]

const STATUS_STYLE: Record<string, string> = {
  PENDENTE: 'bg-yellow-100 text-yellow-800',
  PROCESSANDO: 'bg-blue-100 text-blue-800',
  CONCLUÍDO: 'bg-green-100 text-green-800',
  ERRO: 'bg-red-100 text-red-800',
}

type JobView = {
  jobId: string
  status: string
  downloadUrl?: string
  errorMessage?: string
}

function Home() {
  const [file, setFile] = useState<File | undefined>()
  const [targetFormat, setTargetFormat] = useState('webp')
  const [notifyEmail, setNotifyEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState<JobView | null>(null)
  const timer = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => () => clearInterval(timer.current), [])

  const poll = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`${API_URL}/jobs/${jobId}`)
      if (!res.ok) throw new Error(`consulta falhou (${res.status})`)
      const data: JobView = await res.json()
      setJob(data)
      if (data.status === 'CONCLUÍDO' || data.status === 'ERRO')
        clearInterval(timer.current)
    } catch (pollErr) {
      setError((pollErr as Error).message)
      clearInterval(timer.current)
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setJob(null)
    if (!file) return setError('Selecione um arquivo.')
    if (!notifyEmail.includes('@')) return setError('Informe um e-mail válido.')

    setSubmitting(true)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('targetFormat', targetFormat)
      form.append('notifyEmail', notifyEmail)
      const res = await fetch(`${API_URL}/jobs`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok)
        throw new Error(
          data.message?.join?.(', ') ?? data.message ?? `erro ${res.status}`,
        )
      const jobId: string = data.jobId
      setJob({ jobId, status: 'PENDENTE' })
      timer.current = setInterval(() => void poll(jobId), 3000)
      void poll(jobId)
    } catch (subErr) {
      setError((subErr as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-2xl font-bold text-slate-800">
          Conversor de vídeo, áudio e imagem
        </h1>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl bg-white p-6 shadow"
        >
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Arquivo</span>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0])}
              className="mt-1 w-full text-sm file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-3 file:py-1 file:text-white"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-600">
              Converter para
            </span>
            <select
              value={targetFormat}
              onChange={(e) => setTargetFormat(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
            >
              {FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-600">
              E-mail para notificação
            </span>
            <input
              type="email"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              placeholder="voce@exemplo.dev"
              className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded bg-slate-800 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? 'Enviando…' : 'Iniciar conversão'}
          </button>
        </form>

        {error && (
          <div
            className="rounded-lg bg-red-100 p-4 text-sm text-red-700"
            role="alert"
          >
            ⚠ {error}
          </div>
        )}

        {job && (
          <div className="space-y-3 rounded-xl bg-white p-6 shadow">
            <div>
              <span className="text-sm font-medium text-slate-600">Job</span>
              <p className="font-mono text-sm break-all">{job.jobId}</p>
            </div>
            <div>
              <span
                className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${STATUS_STYLE[job.status] ?? 'bg-slate-100'}`}
              >
                {job.status}
              </span>
              {(job.status === 'PENDENTE' || job.status === 'PROCESSANDO') && (
                <span className="ml-2 text-xs text-slate-500">
                  atualizando a cada 3 s…
                </span>
              )}
            </div>
            {job.errorMessage && (
              <div className="text-sm text-red-600">{job.errorMessage}</div>
            )}
            {job.downloadUrl && (
              <a
                href={job.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700"
              >
                Baixar arquivo convertido
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
