import type { GraphEvent } from '../core/types';
import { createEventSource } from './event-source';

// Structural subset keeps the core independent of the Supabase SDK and its client setup.
interface ConversationChannel {
  on(type: 'broadcast', filter: { event: string }, callback: (message: { payload: GraphEvent }) => void): ConversationChannel;
  subscribe(callback: (status: string) => void): ConversationChannel;
}
interface RealtimeClient {
  channel(topic: string, options: { config: { private: boolean } }): ConversationChannel;
  removeChannel(channel: ConversationChannel): unknown;
}
/** Shell must obtain this conversation from the signed in user and provide owner checked polling.
 * Private broadcast admission and event validation belong at the server boundary, not in this UI.
 */
export function createSupabaseEventSource(client: RealtimeClient, conversationId: string, poll: (conversationId: string) => Promise<GraphEvent[]>) {
  return createEventSource({
    poll,
    subscribe(id, event, failed) {
      const channel = client.channel(`jarvis:conversation:${id}`, { config: { private: true } })
        .on('broadcast', { event: 'graph_event' }, message => event(message.payload))
        .subscribe(status => failed(status !== 'SUBSCRIBED'));
      return () => { void client.removeChannel(channel); };
    },
  }, conversationId);
}
