import { Inbox } from '@novu/react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'

// One Novu subscriber per staff member (their Convex users._id)
function Novu() {
  const me = useQuery(api.users.me)
  if (!me?.active) return null
  return (
    <Inbox
      applicationIdentifier="mLtXHnJfZNRB"
      subscriberId={me.id}
      socketUrl="wss://socket.novu.co"
      appearance={{
        variables: {
          colorPrimary: "#DD2450",
          colorForeground: "#0E121B"
        }
      }}
    />
  )
}

export default Novu
