import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Clapperboard, Copy, Radio, Users, Video } from 'lucide-react'
import { io } from 'socket.io-client'
import './App.css'
import Player from './Player.jsx'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000'

function RoleBadge({ role }) {
  const style = {
    Host: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
    Moderator: 'border-sky-400/20 bg-sky-400/10 text-sky-300',
    Participant: 'border-white/10 bg-white/[0.06] text-slate-400',
  }[role] || 'border-white/10 bg-white/[0.06] text-slate-400'

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${style}`}>
      {role}
    </span>
  )
}

function App() {
  const socket = useMemo(() => io(SERVER_URL, { autoConnect: false }), [])
  const [username, setUsername] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [roomId, setRoomId] = useState('')
  const [participants, setParticipants] = useState([])
  const [playerVideoId, setPlayerVideoId] = useState('')
  const [playbackState, setPlaybackState] = useState(null)
  const [playerCommand, setPlayerCommand] = useState(null)
  const [connection, setConnection] = useState('connecting')
  const [toast, setToast] = useState('')
  const [copied, setCopied] = useState(false)
  const [pendingRequests, setPendingRequests] = useState([])
  const [requestStatus, setRequestStatus] = useState('')
  const myRequestId = useRef('')
  const commandRevision = useRef(0)

  useEffect(() => {
    const showError = (error) => {
      setToast(typeof error === 'string' ? error : error?.message || 'Something went wrong.')
    }
    const updateParticipants = (payload) => {
      if (Array.isArray(payload?.participants)) {
        setParticipants(payload.participants)
      }
    }
    const handleCreated = (payload) => {
      setRoomId(payload.roomId)
      setParticipants(payload.participants || [])
      setPlayerVideoId('')
      setPlaybackState(null)
      setPlayerCommand(null)
      setPendingRequests([])
      setRequestStatus('')
      myRequestId.current = ''
    }
    const handleSync = (payload) => {
      setRoomId(payload.roomId)
      setParticipants(payload.participants || [])
      setPlayerVideoId(payload.state?.videoId || '')
      setPlaybackState(payload.state || null)
      setPlayerCommand({
        event: 'sync_state',
        state: payload.state,
        revision: ++commandRevision.current,
      })
    }
    const handlePlayback = (event) => (payload) => {
      setPlayerVideoId((current) => current || payload?.videoId || '')
      setPlaybackState(payload)
      setPlayerCommand({
        event,
        state: payload,
        revision: ++commandRevision.current,
      })
    }
    const handleRemovedFromRoom = () => {
      setRoomId('')
      setParticipants([])
      setPlayerVideoId('')
      setPlaybackState(null)
      setPlayerCommand(null)
      setPendingRequests([])
      setRequestStatus('')
      myRequestId.current = ''
      setToast('You were removed from the room.')
    }
    const handleRequestSent = (payload) => {
      myRequestId.current = payload.requestId
      setRequestStatus('Waiting for approval...')
    }
    const handleChangeRequested = (request) => {
      setPendingRequests((current) => [
        ...current.filter((item) => item.requestId !== request.requestId),
        request,
      ])
    }
    const handleRequestResolved = (resolution) => {
      setPendingRequests((current) => current.filter(
        (request) => request.requestId !== resolution.requestId,
      ))
      if (resolution.requestId === myRequestId.current) {
        myRequestId.current = ''
        setRequestStatus(resolution.approved ? 'Request approved.' : 'Request rejected or expired.')
      }
    }

    socket.on('connect', () => setConnection('connected'))
    socket.on('disconnect', () => setConnection('disconnected'))
    socket.on('connect_error', showError)
    socket.on('error', showError)
    socket.on('room_created', handleCreated)
    socket.on('sync_state', handleSync)
    socket.on('user_joined', updateParticipants)
    socket.on('user_left', updateParticipants)
    socket.on('role_assigned', updateParticipants)
    socket.on('participant_removed', updateParticipants)
    socket.on('removed_from_room', handleRemovedFromRoom)
    socket.on('play', handlePlayback('play'))
    socket.on('pause', handlePlayback('pause'))
    socket.on('seek', handlePlayback('seek'))
    socket.on('change_video', handlePlayback('change_video'))
    socket.on('request_sent', handleRequestSent)
    socket.on('change_requested', handleChangeRequested)
    socket.on('request_resolved', handleRequestResolved)
    socket.connect()

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
    }
  }, [commandRevision, socket])

  useEffect(() => {
    if (!toast) return undefined
    const timeout = window.setTimeout(() => setToast(''), 3600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const myUser = participants.find((participant) => participant.id === socket.id)
  const canApproveRequests = myUser?.role === 'Host' || myUser?.role === 'Moderator'

  const resolveRequest = (requestId, approve) => {
    socket.emit('resolve_request', { roomId, requestId, approve }, (response) => {
      if (response?.error) setToast(response.error)
    })
  }

  const handleCreateRoom = (event) => {
    event.preventDefault()
    if (!username.trim()) {
      setToast('Enter your name before creating a room.')
      return
    }
    if (!socket.connected) {
      setToast('Connecting to the server. Try again in a moment.')
      return
    }
    socket.emit('create_room', { username: username.trim() })
  }

  const handleJoinRoom = (event) => {
    event.preventDefault()
    if (!username.trim()) {
      setToast('Enter your name before joining a room.')
      return
    }
    if (!roomCode.trim()) {
      setToast('Enter a room code to join.')
      return
    }
    if (!socket.connected) {
      setToast('Connecting to the server. Try again in a moment.')
      return
    }
    socket.emit('join_room', {
      roomId: roomCode.trim().toUpperCase(),
      username: username.trim(),
    })
  }

  const copyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setToast('Could not copy the room code. Please copy it manually.')
    }
  }

  const leaveRoom = () => {
    socket.emit('leave_room', { roomId }, (response) => {
      if (response?.error) {
        setToast(response.error)
        return
      }
      setRoomId('')
      setParticipants([])
      setPlayerVideoId('')
      setPlaybackState(null)
      setPlayerCommand(null)
      setPendingRequests([])
      setRequestStatus('')
      myRequestId.current = ''
    })
  }

  return (
    <main className="app-shell relative min-h-screen overflow-hidden px-5 py-6 text-slate-100 sm:px-8 sm:py-9">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl flex-col">
        <header className="flex items-center justify-between">
          <a href="/" className="flex items-center gap-3 text-white no-underline" aria-label="Loop home">
            <span className="brand-mark"><Clapperboard size={19} strokeWidth={2.2} /></span>
            <span className="text-lg font-bold tracking-tight">loop<span className="text-violet-300">.</span></span>
          </a>
          <div className="flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-white/[0.035] px-3.5 py-2 text-xs text-slate-400">
            <span className={`h-1.5 w-1.5 rounded-full ${connection === 'connected' ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]' : 'bg-amber-400'}`} />
            {connection === 'connected' ? 'Server connected' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </div>
        </header>

        {roomId ? (
          <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-8">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <button
                type="button"
                onClick={leaveRoom}
                className="inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition hover:text-white"
              >
                <ArrowLeft size={16} /> Back to lobby
              </button>
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/[0.07] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                  <Radio size={13} /> Watch party live
                </span>
                {myUser && <RoleBadge role={myUser.role} />}
                <button
                  type="button"
                  onClick={copyRoomCode}
                  className="group inline-flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3.5 py-2 text-left transition hover:border-violet-300/30"
                  aria-label="Copy room code"
                >
                  <span>
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">Room code</span>
                    <span className="block font-mono text-sm font-bold tracking-[0.2em] text-white">{roomId}</span>
                  </span>
                  <span className="text-violet-300">{copied ? <Check size={15} /> : <Copy size={15} />}</span>
                </button>
              </div>
            </div>

            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Player
                socket={socket}
                roomId={roomId}
                role={myUser?.role || 'Participant'}
                videoId={playerVideoId}
                playbackState={playbackState}
                command={playerCommand}
                requestStatus={requestStatus}
                onError={setToast}
              />
              <aside className="panel rounded-3xl p-5 sm:p-6">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-white">In this room</h2>
                    <p className="mt-1 text-xs text-slate-500">Everyone watching together</p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-slate-300">
                    <Users size={14} /> {participants.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {participants.map((participant) => (
                    <div
                      key={participant.id}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.055] bg-white/[0.025] px-3 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="avatar">{participant.username?.trim()?.[0]?.toUpperCase() || '?'}</span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-100">
                            {participant.username}
                            {participant.id === socket.id && <span className="ml-2 text-xs font-normal text-slate-500"> you</span>}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">{participant.role === 'Host' ? 'Party host' : participant.role === 'Moderator' ? 'Can control playback' : 'Watching'}</p>
                        </div>
                      </div>
                      <RoleBadge role={participant.role} />
                    </div>
                  ))}
                  {participants.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
                      Waiting for someone to join…
                    </p>
                  )}
                </div>
                {canApproveRequests && (
                  <div className="mt-6 border-t border-white/[0.07] pt-5">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-semibold text-white">Pending requests</h3>
                      <span className="text-xs text-slate-500">{pendingRequests.length}</span>
                    </div>
                    {pendingRequests.length === 0 ? (
                      <p className="rounded-xl bg-white/[0.025] px-3 py-4 text-xs text-slate-500">
                        No pending requests.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {pendingRequests.map((request) => (
                          <div key={request.requestId} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                            <p className="text-sm font-medium text-slate-200">{request.requesterName}</p>
                            <p className="mt-1 break-all text-xs text-slate-500">
                              {request.type === 'change_video'
                                ? `Video change: ${request.payload.videoId}`
                                : request.type === 'play'
                                  ? 'Play'
                                  : request.type === 'pause'
                                    ? 'Pause'
                                    : `Seek to ${request.payload.currentTime}s`}
                            </p>
                            <div className="mt-3 flex gap-2">
                              <button
                                type="button"
                                className="primary-button h-9 px-3 text-xs"
                                onClick={() => resolveRequest(request.requestId, true)}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                className="secondary-button h-9 px-3 text-xs"
                                onClick={() => resolveRequest(request.requestId, false)}
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </aside>
            </div>
          </section>
        ) : (
          <section className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1fr_0.88fr] lg:gap-20">
            <div className="max-w-xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-300/15 bg-violet-300/[0.07] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-200">
                <Video size={13} /> Your people. Your playback.
              </div>
              <h1 className="text-5xl font-bold leading-[1.06] tracking-[-0.055em] text-white sm:text-6xl">
                Good videos<br />are better <span className="gradient-text">together.</span>
              </h1>
              <p className="mt-6 max-w-md text-base leading-7 text-slate-400">
                Start a room, invite your friends, and make every watch feel like movie night.
              </p>
              <div className="mt-9 flex items-center gap-3 text-xs text-slate-500">
                <span className="flex -space-x-2">
                  {['M', 'J', 'A'].map((letter, index) => (
                    <span key={letter} className={`mini-avatar mini-avatar-${index}`}>{letter}</span>
                  ))}
                </span>
                <span>Made for sharing the moment</span>
              </div>
            </div>

            <div className="panel mx-auto w-full max-w-md rounded-3xl p-6 sm:p-8">
              <div className="mb-7">
                <p className="text-xs font-semibold uppercase tracking-[0.17em] text-violet-300">Let’s get you in</p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Start watching</h2>
              </div>
              <form onSubmit={handleCreateRoom}>
                <label htmlFor="username" className="field-label">Your name</label>
                <input
                  id="username"
                  className="text-field"
                  type="text"
                  autoComplete="nickname"
                  maxLength={32}
                  placeholder="How should we call you?"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <button className="primary-button mt-4 w-full" type="submit">
                  <Video size={17} /> Create Room
                </button>
              </form>
              <div className="my-6 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                <span className="h-px flex-1 bg-white/[0.08]" /> or join a room <span className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <form onSubmit={handleJoinRoom}>
                <label htmlFor="room-code" className="field-label">Room code</label>
                <input
                  id="room-code"
                  className="text-field font-mono uppercase tracking-[0.18em] placeholder:font-sans placeholder:normal-case placeholder:tracking-normal"
                  type="text"
                  autoComplete="off"
                  maxLength={6}
                  placeholder="Enter 6-character code"
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value.replace(/\s/g, '').slice(0, 6))}
                />
                <button className="secondary-button mt-3 w-full" type="submit">
                  <Users size={17} /> Join Room
                </button>
              </form>
              <p className="mt-6 text-center text-[11px] leading-5 text-slate-600">
                By joining, you agree to be kind and let the host pick the next video.
              </p>
            </div>
          </section>
        )}

        <footer className="flex items-center justify-between border-t border-white/[0.06] py-5 text-[11px] text-slate-600">
          <span>loop. &mdash; watch together, wherever.</span>
          <span>Private rooms. Shared moments.</span>
        </footer>
      </div>

      {toast && (
        <div role="alert" className="toast fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-rose-300/15 bg-slate-900 px-4 py-3 text-sm text-slate-100 shadow-2xl">
          <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400" />
          <span>{toast}</span>
          <button type="button" className="ml-2 text-slate-500 hover:text-white" onClick={() => setToast('')} aria-label="Dismiss error">×</button>
        </div>
      )}
    </main>
  )
}

export default App
