import { useSearchParams } from 'react-router-dom'
import LeftNav from '../components/LeftNav'
import PdfWorkspace from '../components/PdfWorkspace'

export default function BlockEstimatePage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('id')

  return (
    // Workspace page = focus mode. LeftNav defaults to collapsed
    // (icon-only) so the canvas gets maximum horizontal room; the
    // user can toggle it open via the chevron on the rail edge.
    // ProjectBar inside PdfWorkspace handles project-specific
    // chrome (Save / Mark complete / Export); LeftNav handles app
    // navigation.
    //
    // `pt-3` on the right column gives the ProjectBar breathing
    // room from the top of the viewport — without the old Header
    // there's nothing else absorbing that whitespace, so the bar
    // would otherwise sit flush against the browser chrome.
    <div className="min-h-screen bg-ink-900 text-ink-50 flex">
      <LeftNav defaultCollapsed />
      <div className="flex-1 min-w-0 pt-3">
        <PdfWorkspace mode="block" projectId={projectId} />
      </div>
    </div>
  )
}
