using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Terraria.ModLoader;

namespace TerrariaTunnelTelemetry;

/// <summary>Owns the local TCP stream that delivers the newest telemetry snapshot.</summary>
internal sealed class TelemetryStreamServer : IDisposable
{
    private readonly Mod _mod;
    private readonly ConcurrentDictionary<int, TelemetryClient> _clients = new();
    private TcpListener? _listener;
    private CancellationTokenSource? _shutdown;
    private string? _latestSnapshot;
    private int _nextClientId;

    public TelemetryStreamServer(Mod mod)
    {
        _mod = mod;
    }

    public void Start(int port)
    {
        if (_listener != null)
            throw new InvalidOperationException("The telemetry stream is already running.");

        _shutdown = new CancellationTokenSource();
        _listener = new TcpListener(IPAddress.Loopback, port);

        try
        {
            _listener.Start();
            _ = AcceptClientsAsync(_listener, _shutdown.Token);
            _mod.Logger.Info($"Telemetry JSONL stream listening on 127.0.0.1:{port}.");
        }
        catch (Exception exception)
        {
            _mod.Logger.Error(
                $"Could not start telemetry listener; telemetry is disabled: {exception.Message}"
            );
            Dispose();
        }
    }

    public void Publish(string jsonLine)
    {
        Volatile.Write(ref _latestSnapshot, jsonLine);
        foreach (var client in _clients.Values)
            client.Publish(jsonLine);
    }

    public void Dispose()
    {
        _shutdown?.Cancel();
        _listener?.Stop();

        foreach (var client in _clients.Values)
            client.Stop();

        _clients.Clear();
        _listener = null;
        _shutdown?.Dispose();
        _shutdown = null;
    }

    private async Task AcceptClientsAsync(TcpListener listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient socket;
            try
            {
                socket = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (SocketException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            socket.NoDelay = true;
            var id = Interlocked.Increment(ref _nextClientId);
            var client = new TelemetryClient(socket, () => _clients.TryRemove(id, out _));
            _clients[id] = client;

            // A new reader needs the current state immediately, without waiting for another game tick.
            if (Volatile.Read(ref _latestSnapshot) is { } latest)
                client.Publish(latest);

            _ = client.RunAsync(cancellationToken);
            _mod.Logger.Info($"Tunnel monitor connected ({_clients.Count} telemetry client(s)).");
        }
    }

    private sealed class TelemetryClient
    {
        private readonly TcpClient _socket;
        private readonly Action _onClosed;
        private readonly Channel<string> _pending = Channel.CreateBounded<string>(
            new BoundedChannelOptions(1)
            {
                // Telemetry is a state snapshot, so stale queued snapshots can be discarded safely.
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false,
            }
        );

        public TelemetryClient(TcpClient socket, Action onClosed)
        {
            _socket = socket;
            _onClosed = onClosed;
        }

        public void Publish(string jsonLine) => _pending.Writer.TryWrite(jsonLine);

        public async Task RunAsync(CancellationToken cancellationToken)
        {
            try
            {
                var stream = _socket.GetStream();
                await foreach (
                    var jsonLine in _pending.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false)
                )
                {
                    var bytes = Encoding.UTF8.GetBytes(jsonLine);
                    await stream.WriteAsync(bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
                    await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            finally
            {
                Stop();
                _onClosed();
            }
        }

        public void Stop()
        {
            _pending.Writer.TryComplete();
            try
            {
                _socket.Close();
            }
            catch { }
        }
    }
}
