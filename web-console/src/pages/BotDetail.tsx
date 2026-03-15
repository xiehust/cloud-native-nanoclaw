import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { bots as botsApi, channels as channelsApi, groups as groupsApi, Bot, ChannelConfig, Group } from '../lib/api';

export default function BotDetail() {
  const { botId } = useParams<{ botId: string }>();
  const [bot, setBot] = useState<Bot | null>(null);
  const [channelsList, setChannels] = useState<ChannelConfig[]>([]);
  const [groupsList, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  useEffect(() => { if (botId) loadData(); }, [botId]);

  async function loadData() {
    try {
      const [botData, chs, grps] = await Promise.all([
        botsApi.get(botId!),
        channelsApi.list(botId!),
        groupsApi.list(botId!),
      ]);
      setBot(botData);
      setChannels(chs);
      setGroups(grps);
      setEditName(botData.name);
      setEditDesc(botData.description || '');
    } catch (err) {
      console.error('Failed to load bot:', err);
    } finally {
      setLoading(false);
    }
  }

  async function saveBot() {
    await botsApi.update(botId!, { name: editName, description: editDesc });
    setEditing(false);
    loadData();
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!bot) return <div className="text-center py-12 text-gray-500">Bot not found</div>;

  return (
    <div className="space-y-8">
      {/* Bot info */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-start">
          <div>
            {editing ? (
              <div className="space-y-3">
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="text-2xl font-bold border-b-2 border-indigo-500 focus:outline-none" />
                <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Description..."
                  className="block w-full text-sm border rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <div className="flex gap-2">
                  <button onClick={saveBot} className="px-3 py-1 bg-indigo-600 text-white rounded text-sm">Save</button>
                  <button onClick={() => setEditing(false)} className="px-3 py-1 text-gray-600 text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-bold text-gray-900">{bot.name}</h1>
                {bot.description && <p className="mt-1 text-gray-600">{bot.description}</p>}
                <p className="mt-2 text-sm text-gray-400">Trigger: {bot.triggerPattern}</p>
              </>
            )}
          </div>
          {!editing && (
            <button onClick={() => setEditing(true)} className="text-sm text-indigo-600 hover:text-indigo-500">Edit</button>
          )}
        </div>
      </div>

      {/* Channels */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Channels</h2>
          <Link to={`/bots/${botId}/channels/new`}
            className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Add Channel</Link>
        </div>
        {channelsList.length === 0 ? (
          <p className="text-gray-500 text-sm">No channels configured. Add one to start receiving messages.</p>
        ) : (
          <div className="space-y-3">
            {channelsList.map((ch) => (
              <div key={ch.channelId} className="flex justify-between items-center p-3 bg-gray-50 rounded">
                <div>
                  <span className="font-medium capitalize">{ch.channelType}</span>
                  <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                    ch.status === 'connected' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                  }`}>{ch.status}</span>
                </div>
                <button onClick={() => channelsApi.delete(botId!, `${ch.channelType}#${ch.channelId}`).then(loadData)}
                  className="text-sm text-red-500 hover:text-red-700">Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Groups */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Groups & Conversations</h2>
        {groupsList.length === 0 ? (
          <p className="text-gray-500 text-sm">No conversations yet. Messages will appear here once users interact with your bot.</p>
        ) : (
          <div className="space-y-2">
            {groupsList.map((g) => (
              <Link key={g.groupJid} to={`/bots/${botId}/messages/${encodeURIComponent(g.groupJid)}`}
                className="flex justify-between items-center p-3 bg-gray-50 rounded hover:bg-gray-100">
                <div>
                  <span className="font-medium">{g.name || g.groupJid}</span>
                  <span className="ml-2 text-xs text-gray-400 capitalize">{g.channelType}</span>
                </div>
                <span className="text-xs text-gray-400">{g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleDateString() : ''}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Quick links */}
      <div className="flex gap-4">
        <Link to={`/bots/${botId}/tasks`}
          className="flex-1 p-4 bg-white rounded-lg shadow text-center hover:shadow-md transition-shadow">
          <h3 className="font-semibold text-gray-900">Scheduled Tasks</h3>
          <p className="text-sm text-gray-500 mt-1">Manage cron jobs and one-time tasks</p>
        </Link>
      </div>
    </div>
  );
}
