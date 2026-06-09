import GstWebRTCAPI from "gstwebrtc-api";
import type { StreamDescriptor } from "../types";
import type { StreamSource } from "./types";
import { resolveSignallingUrl } from "../signalling";

type Producer = { id: string; meta: Record<string, unknown> };
type ConsumerSession = ReturnType<GstWebRTCAPI["createConsumerSession"]>;

// The API exposes no close(), so keep ONE signalling connection per URL, shared across tiles.
const apiPool = new Map<string, GstWebRTCAPI>();
function apiFor(url: string): GstWebRTCAPI {
  let api = apiPool.get(url);
  if (!api) {
    api = new GstWebRTCAPI({
      meta: { name: `dashboard-${Date.now()}` },
      signalingServerUrl: url,
      reconnectionTimeout: 2000,
      webrtcConfig: { iceServers: [] }, // LAN/mesh direct ICE; add STUN/TURN for routed deployments
    });
    apiPool.set(url, api);
  }
  return api;
}

// Resolve the descriptor's producer_id (== webrtcsink meta.name) to the transient signalling peer.id.
function findProducer(api: GstWebRTCAPI, metaName: string, timeoutMs = 8000): Promise<Producer> {
  const match = (p: Producer) => p.meta["name"] === metaName;
  const existing = api.getAvailableProducers().find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise<Producer>((resolve, reject) => {
    const listener = {
      producerAdded: (p: Producer) => {
        if (match(p)) {
          clearTimeout(timer);
          api.unregisterPeerListener(listener);
          resolve(p);
        }
      },
    };
    const timer = setTimeout(() => {
      api.unregisterPeerListener(listener);
      reject(new Error(`producer '${metaName}' not found on the signalling server`));
    }, timeoutMs);
    api.registerPeerListener(listener);
  });
}

/** Consumes a webrtcsink stream via the gstwebrtc-api JS client. */
export class GstWebRtcSource implements StreamSource {
  private session: ConsumerSession | null = null;

  constructor(private readonly descriptor: StreamDescriptor) {}

  async open(video: HTMLVideoElement): Promise<void> {
    const api = apiFor(resolveSignallingUrl(this.descriptor));
    const producer = await findProducer(api, this.descriptor.producer_id);
    const session = api.createConsumerSession(producer.id);
    this.session = session;
    session.addEventListener("streamsChanged", () => {
      const [stream] = session.streams;
      if (stream) {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
      }
    });
    session.connect();
  }

  close(): void {
    try {
      this.session?.close();
    } finally {
      this.session = null;
    }
  }
}
