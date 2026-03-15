import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { groups as groupsApi, Message } from '../lib/api';

export default function Messages() {
  const { botId, groupJid } = useParams<{ botId: string; groupJid: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (botId && groupJid) loadMessages(); }, [botId, groupJid]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function loadMessages() {
    try {
      const data = await groupsApi.messages(botId!, decodeURIComponent(groupJid!));
      setMessages(data);
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-4">Messages</h1>
      <div className="bg-white rounded-lg shadow p-4 max-h-[70vh] overflow-y-auto">
        {messages.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No messages yet</p>
        ) : (
          <div className="space-y-3">
            {messages.map((msg) => (
              <div key={msg.messageId} className={`flex ${msg.isBotMessage ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[70%] rounded-lg px-4 py-2 ${
                  msg.isBotMessage ? 'bg-indigo-50 text-indigo-900' : 'bg-gray-100 text-gray-900'
                }`}>
                  <div className="text-xs font-medium mb-1">{msg.senderName}</div>
                  <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
                  <div className="text-xs text-gray-400 mt-1">{new Date(msg.timestamp).toLocaleString()}</div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}
