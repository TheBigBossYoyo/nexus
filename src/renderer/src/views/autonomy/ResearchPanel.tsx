import type { ResearchArtifact, ResearchDownloadView } from '@shared/research'
import { useResearchList } from '../../lib/queries-autonomy'
import { formatBytes, formatDateTime } from '../../lib/format'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  RefreshIcon,
} from '../../components/ui'
import {
  AUTHORITY_LABEL,
  BACKEND_LABEL,
  RESEARCH_BROWSER_LINE,
  DOWNLOADS_EMPTY,
  DOWNLOAD_STATE_LABEL,
  RESEARCH_EMPTY,
  RESEARCH_UNTRUSTED_LINE,
  SOURCE_TYPE_LABEL,
  artifactHeading,
  downloadName,
  downloadTone,
  screeningWords,
} from './isolationModel'

function Artifact({ artifact }: { artifact: ResearchArtifact }) {
  const screening = screeningWords(artifact.screening)
  return (
    <li
      className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
      data-testid={`research-artifact-${artifact.id}`}
    >
      <div className="break-words font-medium">{artifactHeading(artifact)}</div>
      {/* The address is text: a click here must never navigate the app window. */}
      <div className="break-all font-mono text-code text-text-muted">
        {artifact.canonicalUrl || artifact.url}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-text-secondary">
        <span>{artifact.publisher}</span>
        <span>{SOURCE_TYPE_LABEL[artifact.sourceType]}</span>
        <span>{AUTHORITY_LABEL[artifact.authority]}</span>
        <span data-testid="research-backend">{BACKEND_LABEL[artifact.backend]}</span>
        <span>Retrieved {formatDateTime(artifact.retrievedAt)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={screening.tone}>{screening.label}</Badge>
        {screening.detail ? (
          <span className="text-small text-text-secondary">{screening.detail}</span>
        ) : null}
      </div>
    </li>
  )
}

function Download({ download }: { download: ResearchDownloadView }) {
  return (
    <li
      className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
      data-testid={`research-download-${download.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-medium">{downloadName(download)}</span>
        <Badge tone={downloadTone(download.state)}>{DOWNLOAD_STATE_LABEL[download.state]}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-text-secondary">
        <span>{download.sniffed}</span>
        <span>{formatBytes(download.bytes)}</span>
        <span>Downloaded {formatDateTime(download.downloadedAt)}</span>
      </div>
      <div className="break-all font-mono text-code text-text-muted">
        {download.finalUrl || download.url}
      </div>
      {download.refusal ? (
        <p className="m-0 text-small text-danger">Refused: {download.refusal}</p>
      ) : null}
    </li>
  )
}

/** Project page: what NEXUS read from the public web for this project, and the files it fetched into quarantine. Read-only. */
export function ResearchPanel({ projectId }: { projectId: string }) {
  const research = useResearchList(projectId)
  const data = research.data
  return (
    <Card
      title="Web research"
      description={RESEARCH_UNTRUSTED_LINE}
      actions={
        <Button
          size="sm"
          icon={<RefreshIcon size={12} />}
          loading={research.isFetching}
          onClick={() => void research.refetch()}
          data-testid="research-refresh"
        >
          Refresh
        </Button>
      }
      data-testid="research-panel"
    >
      {research.isPending ? (
        <Loading label="Loading web research" />
      ) : research.isError ? (
        <ErrorNote error={research.error} />
      ) : data ? (
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2" aria-labelledby="research-sources-title">
            <h3 id="research-sources-title" className="m-0 text-body font-semibold">
              Sources read
            </h3>
            <p className="m-0 text-small text-text-secondary" data-testid="research-browser-line">
              {RESEARCH_BROWSER_LINE}
            </p>
            {data.artifacts.length === 0 ? (
              <EmptyState title="Nothing read" className="py-6">
                {RESEARCH_EMPTY}
              </EmptyState>
            ) : (
              <ul
                className="m-0 list-none rounded-lg border bg-surface p-0"
                aria-label="Sources read from the public web"
              >
                {data.artifacts.map((a) => (
                  <Artifact key={a.id} artifact={a} />
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-2" aria-labelledby="research-downloads-title">
            <h3 id="research-downloads-title" className="m-0 text-body font-semibold">
              Downloaded files
            </h3>
            {data.downloads.length === 0 ? (
              <p className="m-0 text-text-secondary">{DOWNLOADS_EMPTY}</p>
            ) : (
              <ul
                className="m-0 list-none rounded-lg border bg-surface p-0"
                aria-label="Files downloaded from the public web"
              >
                {data.downloads.map((d) => (
                  <Download key={d.id} download={d} />
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </Card>
  )
}
