import { useCallback, useEffect, useRef, useState } from 'react'
import YouTube from 'react-youtube'
import { Link2, Play, Video } from 'lucide-react'

const SEEK_TOLERANCE_SECONDS = 2
const REMOTE_UPDATE_GUARD_MS = 500
const SEEK_POLL_INTERVAL_MS = 500

function extractVideoId(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'youtu.be') {
      return url.pathname.split('/').filter(Boolean)[0] || null
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      return url.searchParams.get('v')
    }
  } catch {
    return null
  }
  return null
}

function Player({
  socket,
  roomId,
  role,
  videoId,
  playbackState,
  command,
  requestStatus,
  onError,
}) {
  const canControl = role === 'Host' || role === 'Moderator'
  const [syncEnabled, setSyncEnabled] = useState(canControl)
  const [videoUrl, setVideoUrl] = useState('')
  const [requestVideoUrl, setRequestVideoUrl] = useState('')
  const [playerReady, setPlayerReady] = useState(false)
  const playerRef = useRef(null)
  const loadedVideoIdRef = useRef('')
  const latestStateRef = useRef(playbackState)
  const pendingCommandRef = useRef(null)
  const appliedRevisionRef = useRef(0)
  const isRemoteUpdate = useRef(false)
  const remoteResetTimeoutRef = useRef(null)
  const seekIntervalRef = useRef(null)

  useEffect(() => {
    latestStateRef.current = playbackState
  }, [playbackState])

  const guardRemoteUpdate = useCallback(() => {
    // Ignore player callbacks caused by applying a server command.
    isRemoteUpdate.current = true
    window.clearTimeout(remoteResetTimeoutRef.current)
    remoteResetTimeoutRef.current = window.setTimeout(() => {
      isRemoteUpdate.current = false
    }, REMOTE_UPDATE_GUARD_MS)
  }, [])

  const applyState = useCallback((eventName, state, force = false) => {
    const player = playerRef.current
    if (!player || !state?.videoId) return

    const waitingForEnable = !canControl && !syncEnabled && !force
    const currentTime = Number.isFinite(Number(state.currentTime))
      ? Math.max(0, Number(state.currentTime))
      : 0
    const currentPlayerTime = player.getCurrentTime()
    const videoChanged = loadedVideoIdRef.current !== state.videoId

    guardRemoteUpdate()

    if (
      eventName === 'change_video'
      || eventName === 'sync_state'
      || videoChanged
    ) {
      loadedVideoIdRef.current = state.videoId
      if (eventName === 'play' && !waitingForEnable) {
        player.loadVideoById({ videoId: state.videoId, startSeconds: currentTime })
      } else {
        player.cueVideoById({ videoId: state.videoId, startSeconds: currentTime })
      }
    } else if (
      (eventName === 'play' || eventName === 'seek' || eventName === 'pause' || eventName === 'enable_sync')
      && Math.abs(currentPlayerTime - currentTime) > SEEK_TOLERANCE_SECONDS
    ) {
      player.seekTo(currentTime, true)
    }

    if (waitingForEnable) return
    if (
      eventName === 'play'
      || ((eventName === 'sync_state' || eventName === 'seek' || eventName === 'enable_sync') && state.isPlaying)
    ) {
      player.playVideo()
    } else if (
      eventName === 'pause'
      || ((eventName === 'seek' || eventName === 'enable_sync') && !state.isPlaying)
    ) {
      player.pauseVideo()
    }
  }, [canControl, guardRemoteUpdate, syncEnabled])

  const applyCommand = useCallback((nextCommand) => {
    if (!nextCommand || nextCommand.revision <= appliedRevisionRef.current) return
    if (!playerRef.current) {
      pendingCommandRef.current = nextCommand
      return
    }
    appliedRevisionRef.current = nextCommand.revision
    applyState(nextCommand.event, nextCommand.state)
  }, [applyState])

  useEffect(() => {
    applyCommand(command)
  }, [applyCommand, command])

  useEffect(() => () => {
    window.clearTimeout(remoteResetTimeoutRef.current)
    window.clearInterval(seekIntervalRef.current)
  }, [])

  const emitPlayback = useCallback((eventName, payload) => {
    if (canControl) {
      socket.emit(eventName, { roomId, ...payload })
    }
  }, [canControl, roomId, socket])

  const handleReady = (event) => {
    playerRef.current = event.target
    loadedVideoIdRef.current = videoId
    setPlayerReady(true)

    if (pendingCommandRef.current) {
      applyCommand(pendingCommandRef.current)
      pendingCommandRef.current = null
    } else if (latestStateRef.current?.videoId) {
      applyState('sync_state', latestStateRef.current)
    }
  }

  const handleStateChange = (event) => {
    if (!canControl || isRemoteUpdate.current) return

    const player = event.target
    if (event.data === 1) {
      emitPlayback('play', { currentTime: player.getCurrentTime() })
    } else if (event.data === 2 || event.data === 0) {
      emitPlayback('pause', {})
    }
  }

  const enableSync = () => {
    setSyncEnabled(true)
    if (latestStateRef.current) {
      applyState('enable_sync', latestStateRef.current, true)
    }
  }

  const requestPending = requestStatus === 'Waiting for approval...'

  const submitVideo = (event) => {
    event.preventDefault()
    const videoId = extractVideoId(videoUrl.trim())
    if (!videoId) {
      onError('Enter a valid youtu.be or youtube.com/watch?v= link.')
      return
    }
    socket.emit('change_video', { roomId, videoId })
    setVideoUrl('')
  }

  const submitVideoRequest = (event) => {
    event.preventDefault()
    const requestedVideoId = extractVideoId(requestVideoUrl.trim())
    if (!requestedVideoId) {
      onError('Enter a valid youtu.be or youtube.com/watch?v= link.')
      return
    }
    socket.emit('request_change', {
      roomId,
      type: 'change_video',
      payload: { videoId: requestedVideoId },
    }, (response) => {
      if (response?.error) onError(response.error)
    })
    setRequestVideoUrl('')
  }

  const requestPlayback = () => {
    const type = playbackState?.isPlaying ? 'pause' : 'play'
    const payload = type === 'play'
      ? { currentTime: playbackState?.currentTime ?? 0 }
      : {}
    socket.emit('request_change', { roomId, type, payload }, (response) => {
      if (response?.error) onError(response.error)
    })
  }

  useEffect(() => {
    window.clearInterval(seekIntervalRef.current)
    if (!canControl || !playerRef.current) return undefined

    let previousTime = playerRef.current.getCurrentTime()
    let previousCheck = Date.now()
    seekIntervalRef.current = window.setInterval(() => {
      const player = playerRef.current
      if (!player) return

      const now = Date.now()
      const currentTime = player.getCurrentTime()
      if (isRemoteUpdate.current || player.getPlayerState() !== 1) {
        previousTime = currentTime
        previousCheck = now
        return
      }

      const expectedTime = previousTime + ((now - previousCheck) / 1000)
      if (Math.abs(currentTime - expectedTime) > SEEK_TOLERANCE_SECONDS) {
        emitPlayback('seek', { currentTime })
      }
      previousTime = currentTime
      previousCheck = now
    }, SEEK_POLL_INTERVAL_MS)

    return () => window.clearInterval(seekIntervalRef.current)
  }, [canControl, emitPlayback, playerReady])

  const playerOptions = {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: canControl ? 1 : 0,
      disablekb: canControl ? 0 : 1,
      playsinline: 1,
      rel: 0,
    },
  }

  return (
    <div className="panel overflow-hidden rounded-3xl">
      <div className="border-b border-white/[0.07] px-5 py-4 sm:px-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Now watching</h2>
            <p className="mt-1 text-xs text-slate-500">
              {canControl ? 'Playback controls are enabled' : 'Synced with the room host'}
            </p>
          </div>
          {!canControl && !syncEnabled && (
            <button type="button" className="primary-button h-10 px-3 text-xs" onClick={enableSync}>
              <Play size={14} fill="currentColor" /> Click to enable sync
            </button>
          )}
        </div>
      </div>

      {canControl && (
        <form onSubmit={submitVideo} className="flex gap-2 border-b border-white/[0.06] p-4 sm:px-5">
          <label className="sr-only" htmlFor="video-url">YouTube video link</label>
          <div className="relative min-w-0 flex-1">
            <Link2 className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
            <input
              id="video-url"
              className="text-field h-11 pl-10"
              type="url"
              placeholder="Paste a YouTube link"
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
            />
          </div>
          <button type="submit" className="secondary-button h-11 shrink-0 px-4 text-xs">
            <Video size={15} /> Load video
          </button>
        </form>
      )}

      {!canControl && (
        <div className="space-y-3 border-b border-white/[0.06] p-4 sm:px-5">
          <div>
            <h3 className="text-sm font-semibold text-white">Request play/pause</h3>
            <p className="mt-1 text-xs text-slate-500">Ask a Host or Moderator to change playback.</p>
          </div>
          <button
            type="button"
            className="secondary-button h-10 px-4 text-xs"
            onClick={requestPlayback}
            disabled={requestPending}
          >
            <Play size={14} fill="currentColor" />
            Request {playbackState?.isPlaying ? 'pause' : 'play'}
          </button>
          <form onSubmit={submitVideoRequest} className="flex gap-2">
            <label className="sr-only" htmlFor="request-video-url">YouTube video link to request</label>
            <div className="relative min-w-0 flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
              <input
                id="request-video-url"
                className="text-field h-11 pl-10"
                type="url"
                placeholder="Paste a YouTube link"
                value={requestVideoUrl}
                onChange={(event) => setRequestVideoUrl(event.target.value)}
                disabled={requestPending}
              />
            </div>
            <button
              type="submit"
              className="secondary-button h-11 shrink-0 px-4 text-xs"
              disabled={requestPending}
            >
              Request video change
            </button>
          </form>
          {requestStatus && (
            <p role="status" className="text-xs text-violet-200">{requestStatus}</p>
          )}
        </div>
      )}

      <div className="player-frame relative aspect-video bg-black">
        {videoId ? (
          <>
            <YouTube
              videoId={videoId}
              opts={playerOptions}
              className="h-full w-full"
              iframeClassName="h-full w-full"
              onReady={handleReady}
              onStateChange={handleStateChange}
            />
            {!canControl && <div className="absolute inset-0 z-10 cursor-not-allowed" aria-label="Playback controlled by the host" />}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-violet-300">
              <Video size={21} />
            </span>
            <div>
              <p className="text-sm font-medium text-slate-300">No video selected</p>
              <p className="mt-1 text-xs text-slate-600">{canControl ? 'Paste a YouTube link above to get started.' : 'The host will choose a video shortly.'}</p>
            </div>
          </div>
        )}
      </div>
      {!canControl && (
        <p className="px-5 py-3 text-center text-[11px] text-slate-500">
          Playback is controlled by the host and moderators.
        </p>
      )}
    </div>
  )
}

export default Player
