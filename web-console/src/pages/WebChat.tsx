import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Send, MessageSquare, Loader2 } from 'lucide-react';
import {
  webchat,
  bots as botsApi,
  type Message,
  type Bot,
  type WebChatSocketEvent,
} from '../lib/api';

export default function WebChat() {
  const { t } = useTranslation();
  const { botId } = useParams<{ botId: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const mergeMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((item) => item.messageId === msg.messageId)) return prev;
      return [...prev, msg];
    });
  }, []);

  // Load bot info
  useEffect(() => {
    if (!botId) return;
    botsApi.get(botId)
      .then((b) => {
        setBot(b);
      })
      .catch((err) => console.error('Failed to load webchat:', err))
      .finally(() => setLoading(false));
  }, [botId]);

  // WebSocket stream for history + bot replies
  useEffect(() => {
    if (!botId) return;
    let disposed = false;
    let socket: WebSocket | null = null;

    setConnected(false);
    setConnectionError(null);
    setMessages([]);

    webchat.connect(botId, {
      onOpen: () => {
        if (disposed) return;
        setConnected(true);
        setConnectionError(null);
      },
      onClose: () => {
        if (disposed) return;
        setConnected(false);
      },
      onError: () => {
        if (disposed) return;
        setConnectionError('WebSocket connection failed');
      },
      onEvent: (event: WebChatSocketEvent) => {
        if (disposed) return;
        if (event.type === 'history') {
          setMessages(event.messages);
        } else if (event.type === 'message') {
          mergeMessage(event.message);
        } else if (event.type === 'error') {
          setConnectionError(event.error);
        }
      },
    })
      .then((ws) => {
        if (disposed) {
          ws.close();
          return;
        }
        socket = ws;
        socketRef.current = ws;
      })
      .catch((err) => {
        if (!disposed) {
          setConnectionError(err instanceof Error ? err.message : 'WebSocket connection failed');
        }
      });

    return () => {
      disposed = true;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket?.close();
    };
  }, [botId, mergeMessage]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const socket = socketRef.current;
    if (!text || !botId || sending || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    setSending(true);

    try {
      webchat.send(socket, text, `client-${Date.now()}`);
      setInput('');
    } catch (err) {
      console.error('Failed to send:', err);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [input, botId, sending]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 pb-4">
        <Link
          to={`/bots/${botId}`}
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft size={16} /> {t('common.back')}
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">
          {t('webchat.title')} — {bot?.name || 'Bot'}
        </h1>
        <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
          {connected ? 'WebSocket Online' : 'WebSocket Offline'}
        </span>
      </div>

      {/* Chat area */}
      <div className="flex-1 min-h-0 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
        {connectionError && (
          <div className="px-6 py-3 text-sm text-red-600 border-b border-red-100 bg-red-50">
            {connectionError}
          </div>
        )}
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <MessageSquare size={40} />
              <p className="mt-2 text-sm">{t('webchat.empty')}</p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.messageId}
                className={`flex ${msg.isBotMessage ? 'justify-start' : 'justify-end'}`}
              >
                <div className="max-w-[70%]">
                  <p
                    className={`text-xs mb-1 ${
                      msg.isBotMessage ? 'text-slate-500' : 'text-slate-500 text-right'
                    }`}
                  >
                    {msg.isBotMessage ? (bot?.name || 'Bot') : t('webchat.you')}
                  </p>
                  <div
                    className={`rounded-xl px-4 py-3 text-sm ${
                      msg.isBotMessage
                        ? 'bg-slate-50 border border-slate-200'
                        : 'bg-accent-500 text-white'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  </div>
                  <p
                    className={`text-xs mt-1 text-slate-400 ${
                      msg.isBotMessage ? '' : 'text-right'
                    }`}
                  >
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-slate-200 p-4">
          <div className="flex gap-3 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('webchat.placeholder')}
              rows={1}
              className="flex-1 resize-none rounded-lg border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent"
              style={{ minHeight: '2.5rem', maxHeight: '8rem' }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 128) + 'px';
              }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending || !connected}
              className="flex items-center justify-center h-10 w-10 rounded-lg bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {sending ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Send size={18} />
              )}
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            {t('webchat.hint')}
          </p>
        </div>
      </div>
    </div>
  );
}
