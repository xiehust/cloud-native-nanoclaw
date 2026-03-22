import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { groups as groupsApi, Message } from '../lib/api';

export default function Messages() {
  const { t } = useTranslation();
  const { botId, groupJid } = useParams<{ botId: string; groupJid: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (botId && groupJid) {
      groupsApi
        .messages(botId, groupJid)
        .then(setMessages)
        .catch((err) => console.error('Failed to load messages:', err))
        .finally(() => setLoading(false));
    }
  }, [botId, groupJid]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (loading)
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-500 border-t-transparent" />
      </div>
    );

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          to={`/bots/${botId}`}
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft size={16} /> {t('common.back')}
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">{t('messages.title')}</h1>
      </div>

      {/* Chat */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="h-[600px] overflow-y-auto p-6 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <MessageSquare size={40} />
              <p className="mt-2 text-sm">{t('messages.noMessages')}</p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.messageId}
                className={`flex ${msg.isBotMessage ? 'justify-start' : 'justify-end'}`}
              >
                <div className="max-w-[70%]">
                  <p
                    className={`text-xs mb-1 ${msg.isBotMessage ? 'text-slate-500' : 'text-slate-500 text-right'}`}
                  >
                    {msg.senderName}
                  </p>
                  <div
                    className={`rounded-xl px-4 py-3 text-sm ${
                      msg.isBotMessage
                        ? 'bg-white border border-slate-200 shadow-sm'
                        : 'bg-accent-500 text-white'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  </div>
                  <p
                    className={`text-xs mt-1 text-slate-400 ${msg.isBotMessage ? '' : 'text-right'}`}
                  >
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
