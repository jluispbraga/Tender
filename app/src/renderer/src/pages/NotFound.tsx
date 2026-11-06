import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { navigate } from '@/lib/router'

export function NotFound() {
  return (
    <EmptyState
        page
      icon={<Compass />}
      title="Nothing lives at this address"
      body="The link may be from an older version, or the object was removed."
      action={<Button onClick={() => navigate('containers')}>Back to containers</Button>}
    />
  )
}
