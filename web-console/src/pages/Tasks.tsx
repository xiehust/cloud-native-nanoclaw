import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { tasks as tasksApi, ScheduledTask } from '../lib/api';

export default function Tasks() {
  const { botId } = useParams<{ botId: string }>();
  const [taskList, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTask, setNewTask] = useState({ groupJid: '', prompt: '', scheduleType: 'cron', scheduleValue: '' });

  useEffect(() => { if (botId) loadTasks(); }, [botId]);

  async function loadTasks() {
    try {
      const data = await tasksApi.list(botId!);
      setTasks(data);
    } catch (err) {
      console.error('Failed to load tasks:', err);
    } finally {
      setLoading(false);
    }
  }

  async function createTask() {
    try {
      await tasksApi.create(botId!, newTask);
      setShowCreate(false);
      setNewTask({ groupJid: '', prompt: '', scheduleType: 'cron', scheduleValue: '' });
      loadTasks();
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  }

  async function toggleTask(taskId: string, currentStatus: string) {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    await tasksApi.update(botId!, taskId, { status: newStatus });
    loadTasks();
  }

  async function deleteTask(taskId: string) {
    if (!confirm('Delete this task?')) return;
    await tasksApi.delete(botId!, taskId);
    loadTasks();
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Scheduled Tasks</h1>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm">New Task</button>
      </div>

      {showCreate && (
        <div className="mb-6 p-4 bg-white rounded-lg shadow space-y-3">
          <input placeholder="Group JID" value={newTask.groupJid} onChange={e => setNewTask(prev => ({ ...prev, groupJid: e.target.value }))}
            className="w-full px-3 py-2 border rounded-md text-sm" />
          <textarea placeholder="Prompt" value={newTask.prompt} onChange={e => setNewTask(prev => ({ ...prev, prompt: e.target.value }))}
            className="w-full px-3 py-2 border rounded-md text-sm" rows={3} />
          <div className="flex gap-3">
            <select value={newTask.scheduleType} onChange={e => setNewTask(prev => ({ ...prev, scheduleType: e.target.value }))}
              className="px-3 py-2 border rounded-md text-sm">
              <option value="cron">Cron</option>
              <option value="interval">Interval (ms)</option>
              <option value="once">Once (ISO)</option>
            </select>
            <input placeholder="Schedule value" value={newTask.scheduleValue} onChange={e => setNewTask(prev => ({ ...prev, scheduleValue: e.target.value }))}
              className="flex-1 px-3 py-2 border rounded-md text-sm" />
          </div>
          <div className="flex gap-2">
            <button onClick={createTask} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-600 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {taskList.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <p className="text-gray-500">No scheduled tasks.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {taskList.map((task) => (
            <div key={task.taskId} className="bg-white rounded-lg shadow p-4">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <p className="font-medium text-gray-900">{task.prompt.slice(0, 100)}{task.prompt.length > 100 ? '...' : ''}</p>
                  <p className="text-sm text-gray-500 mt-1">
                    {task.scheduleType}: {task.scheduleValue} | Group: {task.groupJid}
                  </p>
                  {task.nextRun && <p className="text-xs text-gray-400 mt-1">Next: {new Date(task.nextRun).toLocaleString()}</p>}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    task.status === 'active' ? 'bg-green-100 text-green-700' :
                    task.status === 'paused' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-700'
                  }`}>{task.status}</span>
                  <button onClick={() => toggleTask(task.taskId, task.status)} className="text-sm text-indigo-600 hover:text-indigo-500">
                    {task.status === 'active' ? 'Pause' : 'Resume'}
                  </button>
                  <button onClick={() => deleteTask(task.taskId)} className="text-sm text-red-500 hover:text-red-700">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
