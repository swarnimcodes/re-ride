package dev.swarnim.reride

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.PermissionState
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID

@InvokeArg
class StartArgs {
    lateinit var onEvent: Channel
}

@InvokeArg
class AddressArgs {
    lateinit var address: String
}

@InvokeArg
class ConnectArgs {
    lateinit var address: String
    /** Host the phone-side bike service so the pod can write its replies to us (the official app always does). */
    var serveBike: Boolean = false
    /** When present the link runs in "pairing mode": the official app's minimal handshake (see handshake docs). */
    var helloHex: String? = null
}

@InvokeArg
class HexArgs {
    lateinit var hex: String
}

@InvokeArg
class PathArgs {
    lateinit var path: String
}

/**
 * Passive BLE client. Scans, connects, enumerates GATT, reads readable characteristics and enables
 * notifications. It never writes data characteristics: only the standard CCCD descriptor to listen.
 * Everything is reported to the webview as events on a single channel; Rust persists and analyses.
 */
@TauriPlugin(
    permissions = [
        Permission(
            strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT],
            alias = "ble"
        )
    ]
)
class BlePlugin(private val activity: Activity) : Plugin(activity) {
    private val ui = Handler(Looper.getMainLooper())
    private var channel: Channel? = null

    private val adapter: BluetoothAdapter?
        get() = (activity.getSystemService(Activity.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private var scanning = false
    private val lastEmit = HashMap<String, Long>()
    private var gatt: BluetoothGatt? = null
    private var pendingHello: ByteArray? = null
    private var handshake = false
    private var ops = ArrayDeque<Op>()
    private var currentOp: Op? = null
    private val opTimeout = Runnable { fail("operation timed out"); finishOp() }

    // ---------------------------------------------------------------- events

    private fun emit(build: JSObject.() -> Unit) {
        val o = JSObject()
        o.build()
        ui.post { channel?.send(o) }
    }

    private fun status(state: String, message: String) = emit {
        put("type", "status"); put("state", state); put("message", message)
    }

    private fun frame(kind: String, service: UUID?, ch: UUID?, data: ByteArray?, note: String? = null) = emit {
        put("type", "frame"); put("kind", kind)
        put("service", service?.toString()); put("char", ch?.toString())
        put("hex", hex(data)); put("note", note)
    }

    private fun fail(msg: String) {
        val op = currentOp
        frame("error", op?.service, op?.char, null, msg)
    }

    private fun hex(b: ByteArray?): String = b?.joinToString("") { "%02x".format(it) } ?: ""

    // ---------------------------------------------------------------- commands

    @Command
    fun start(invoke: Invoke) {
        channel = invoke.parseArgs(StartArgs::class.java).onEvent
        val r = JSObject()
        r.put("bluetoothOn", adapter?.isEnabled == true)
        r.put("permission", getPermissionState("ble")?.toString() ?: "unknown")
        invoke.resolve(r)
    }

    @Command
    fun scanStart(invoke: Invoke) {
        if (getPermissionState("ble") != PermissionState.GRANTED) {
            requestPermissionForAlias("ble", invoke, "permsThenScan")
        } else {
            ensureBluetoothThenScan(invoke)
        }
    }

    @PermissionCallback
    fun permsThenScan(invoke: Invoke) {
        if (getPermissionState("ble") == PermissionState.GRANTED) ensureBluetoothThenScan(invoke)
        else invoke.reject("Nearby devices permission denied. Enable it in Settings > Apps > re-ride > Permissions.", "permission")
    }

    private fun ensureBluetoothThenScan(invoke: Invoke) {
        val a = adapter ?: return invoke.reject("This device has no Bluetooth", "no_adapter")
        if (!a.isEnabled) {
            startActivityForResult(invoke, Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), "bluetoothEnabled")
        } else {
            beginScan(invoke)
        }
    }

    @ActivityCallback
    fun bluetoothEnabled(invoke: Invoke, result: ActivityResult) {
        if (adapter?.isEnabled == true) beginScan(invoke) else invoke.reject("Bluetooth is off", "bluetooth_off")
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, r: ScanResult) = onResult(r)
        override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach { onResult(it) }
        override fun onScanFailed(errorCode: Int) {
            scanning = false
            status("error", "scan failed (code $errorCode)")
        }
    }

    private fun onResult(r: ScanResult) {
        val addr = r.device.address
        val now = System.currentTimeMillis()
        if (now - (lastEmit[addr] ?: 0L) < 700) return
        lastEmit[addr] = now
        val rec = r.scanRecord
        emit {
            put("type", "device")
            put("address", addr)
            put("name", rec?.deviceName)
            put("rssi", r.rssi)
            if (r.txPower != ScanResult.TX_POWER_NOT_PRESENT) put("txPower", r.txPower)
            put("services", JSArray().also { a -> rec?.serviceUuids?.forEach { a.put(it.uuid.toString()) } })
            val mfr = JSArray()
            rec?.manufacturerSpecificData?.let { m ->
                for (i in 0 until m.size()) mfr.put(JSArray().put(m.keyAt(i)).put(hex(m.valueAt(i))))
            }
            put("manufacturerData", mfr)
            val sd = JSArray()
            rec?.serviceData?.forEach { (k, v) -> sd.put(JSArray().put(k.uuid.toString()).put(hex(v))) }
            put("serviceData", sd)
        }
    }

    private fun beginScan(invoke: Invoke) {
        val scanner = adapter?.bluetoothLeScanner ?: return invoke.reject("Bluetooth scanner unavailable", "no_scanner")
        if (!scanning) {
            scanning = true
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
        }
        status("scanning", "Scanning for nearby BLE devices")
        invoke.resolve()
    }

    @Command
    fun scanStop(invoke: Invoke) {
        stopScan()
        if (gatt == null) status("idle", "Scan stopped")
        invoke.resolve()
    }

    private fun stopScan() {
        if (scanning) {
            try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: SecurityException) {}
            scanning = false
        }
    }

    @Command
    fun connect(invoke: Invoke) {
        if (getPermissionState("ble") != PermissionState.GRANTED) {
            return invoke.reject("Nearby devices permission not granted", "permission")
        }
        val args = invoke.parseArgs(ConnectArgs::class.java)
        val addr = args.address
        pendingHello = null
        args.helloHex?.let {
            pendingHello = validateFrame(it)?.takeIf { f -> f[0].toInt() == 0x21 }
                ?: return invoke.reject("Hello frame rejected", "bad_frame")
        }
        if (gatt != null) return invoke.reject("Already connected. Disconnect first.", "busy")
        val device: BluetoothDevice = try {
            adapter!!.getRemoteDevice(addr)
        } catch (e: Exception) {
            return invoke.reject("Bad address $addr", "bad_address")
        }
        stopScan()
        status("connecting", "Connecting to $addr")
        val go = {
            if (gatt == null) gatt = device.connectGatt(activity, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }
        // The pod acts as a GATT client too: right after connecting it reads our table and writes replies into our
        // 01ff0101. The official app hosts that service before connecting; without it the pod hangs up (~0.5 s).
        if (args.serveBike) hostBikeService(go) else go()
        invoke.resolve()
    }

    /**
     * Send one frame to the pod. Hard allow-list: only in pairing mode, only 20-byte frames with an allow-listed opcode
     * (hello 0x21, PIN 0x20, time 0x50, queries 0x03/0x30), only with a valid CRC, only to the bike characteristic. Everything else is refused.
     */
    @Command
    fun write(invoke: Invoke) {
        val g = gatt ?: return invoke.reject("Not connected", "not_connected")
        if (!handshake) return invoke.reject("Writes are only allowed in pairing mode", "not_allowed")
        val bytes = validateFrame(invoke.parseArgs(HexArgs::class.java).hex)
            ?: return invoke.reject("Frame rejected: only allow-listed frames with a valid CRC may be sent", "bad_frame")
        val c = g.getService(TARGET_SERVICE)?.getCharacteristic(TARGET_CHAR)
            ?: return invoke.reject("Bike characteristic not found", "no_char")
        ui.post {
            ops.add(Op.Write(c, bytes))
            if (currentOp == null) nextOp()
        }
        invoke.resolve()
    }

    @Command
    fun disconnect(invoke: Invoke) {
        gatt?.disconnect()
        invoke.resolve()
    }

    /** Hand an exported file to Android's share sheet. */
    @Command
    fun share(invoke: Invoke) {
        val path = invoke.parseArgs(PathArgs::class.java).path
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(path))
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(send, "Share session"))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not share: ${e.message}", "share_failed")
        }
    }

    // ---------------------------------------------------------------- phone-side GATT server

    private var server: BluetoothGattServer? = null
    private var serverReady = false
    private var afterServer: (() -> Unit)? = null

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            ui.post {
                serverReady = status == BluetoothGatt.GATT_SUCCESS
                frame("info", service.uuid, null, null, "hosting bike service on the phone (status $status)")
                afterServer?.invoke(); afterServer = null
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            frame("info", null, null, null, "pod on our GATT server: ${if (newState == BluetoothProfile.STATE_CONNECTED) "connected" else "disconnected"} (status $status)")
        }

        /** The pod's replies arrive here as writes to our 01ff0101. */
        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int, c: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?
        ) {
            frame("notify", c.service.uuid, c.uuid, value, "pod wrote to the phone's characteristic")
            if (responseNeeded) {
                try { server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value) } catch (_: SecurityException) {}
            }
        }
    }

    /** Same definition as the official app (fj1.N): service 01ff0100 with 01ff0101 = BROADCAST|WRITE_NO_RESPONSE, write permission. */
    private fun hostBikeService(then: () -> Unit) {
        if (server != null && serverReady) return then()
        val mgr = activity.getSystemService(Activity.BLUETOOTH_SERVICE) as BluetoothManager
        val srv = try { mgr.openGattServer(activity, serverCallback) } catch (e: SecurityException) { null }
        if (srv == null) {
            frame("error", null, null, null, "could not open a GATT server (permission?)")
            return then()
        }
        server = srv
        val ch = BluetoothGattCharacteristic(
            TARGET_CHAR,
            BluetoothGattCharacteristic.PROPERTY_BROADCAST or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )
        val svc = BluetoothGattService(TARGET_SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        svc.addCharacteristic(ch)
        afterServer = then
        if (!srv.addService(svc)) {
            frame("error", null, null, null, "addService rejected")
            afterServer = null
            return then()
        }
        // Don't wait forever if the callback never fires.
        ui.postDelayed({ afterServer?.let { it(); afterServer = null } }, 2000)
    }

    private fun closeServer() {
        afterServer = null
        serverReady = false
        try { server?.close() } catch (_: SecurityException) {}
        server = null
    }

    // ---------------------------------------------------------------- GATT

    private sealed class Op(val service: UUID?, val char: UUID?) {
        class Read(val c: BluetoothGattCharacteristic) : Op(c.service.uuid, c.uuid)
        class Subscribe(val c: BluetoothGattCharacteristic) : Op(c.service.uuid, c.uuid)
        class Write(val c: BluetoothGattCharacteristic, val bytes: ByteArray) : Op(c.service.uuid, c.uuid)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, st: Int, newState: Int) {
            ui.post {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    status("connecting", "Connected, discovering services")
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    ui.removeCallbacks(opTimeout)
                    ops.clear(); currentOp = null
                    handshake = false; pendingHello = null
                    closeServer()
                    g.close()
                    gatt = null
                    status("disconnected", if (st == 0) "Disconnected" else "Link lost (status $st)")
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, st: Int) {
            ui.post {
                if (st != BluetoothGatt.GATT_SUCCESS) {
                    status("error", "Service discovery failed ($st)"); g.disconnect(); return@post
                }
                emitGatt(g)
                status("connected", "Connected")
                val hello = pendingHello
                val bike = g.getService(TARGET_SERVICE)?.getCharacteristic(TARGET_CHAR)
                if (hello != null) {
                    if (bike == null) {
                        frame("error", null, null, null, "Pairing mode needs the bike characteristic, which this device lacks")
                    } else {
                        // Exactly what the official app does: register for notifications LOCALLY (the pod has no CCCD
                        // and notifies unconditionally), then send the hello frame straight away. No reads, no CCCD writes.
                        handshake = true
                        g.setCharacteristicNotification(bike, true)
                        frame("info", bike.service.uuid, bike.uuid, null, "pairing mode: listening (local), sending hello")
                        ops.add(Op.Write(bike, hello))
                        nextOp()
                        return@post
                    }
                }
                for (s in g.services) for (c in s.characteristics) {
                    if (c.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) ops.add(Op.Read(c))
                }
                for (s in g.services) for (c in s.characteristics) {
                    val p = c.properties
                    if (p and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0) ops.add(Op.Subscribe(c))
                }
                nextOp()
            }
        }

        @Deprecated("API < 33")
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, st: Int) =
            readDone(c, c.value ?: ByteArray(0), st)

        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, st: Int) =
            readDone(c, value, st)

        @Deprecated("API < 33")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) =
            changed(c, c.value ?: ByteArray(0))

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) =
            changed(c, value)

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, st: Int) {
            ui.post {
                val op = currentOp
                if (op is Op.Write) {
                    if (st == BluetoothGatt.GATT_SUCCESS) frame("write", c.service.uuid, c.uuid, op.bytes)
                    else frame("error", c.service.uuid, c.uuid, null, "write failed (status $st)")
                    finishOp()
                }
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, st: Int) {
            ui.post {
                val c = d.characteristic
                if (st == BluetoothGatt.GATT_SUCCESS) frame("info", c.service.uuid, c.uuid, null, "subscribed")
                else frame("error", c.service.uuid, c.uuid, null, "subscribe failed (status $st)")
                finishOp()
            }
        }
    }

    private fun readDone(c: BluetoothGattCharacteristic, v: ByteArray, st: Int) {
        ui.post {
            if (st == BluetoothGatt.GATT_SUCCESS) frame("read", c.service.uuid, c.uuid, v)
            else frame("error", c.service.uuid, c.uuid, null, "read failed (status $st${if (st == 5 || st == 15) ", needs pairing" else ""})")
            finishOp()
        }
    }

    private fun changed(c: BluetoothGattCharacteristic, v: ByteArray) {
        ui.post { frame("notify", c.service.uuid, c.uuid, v) }
    }

    private fun emitGatt(g: BluetoothGatt) = emit {
        put("type", "gatt")
        val rows = JSArray()
        for (s in g.services) for (c in s.characteristics) {
            val p = c.properties
            val props = JSArray()
            fun has(f: Int, n: String) { if (p and f != 0) props.put(n) }
            has(BluetoothGattCharacteristic.PROPERTY_BROADCAST, "broadcast")
            has(BluetoothGattCharacteristic.PROPERTY_READ, "read")
            has(BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE, "write-no-rsp")
            has(BluetoothGattCharacteristic.PROPERTY_WRITE, "write")
            has(BluetoothGattCharacteristic.PROPERTY_NOTIFY, "notify")
            has(BluetoothGattCharacteristic.PROPERTY_INDICATE, "indicate")
            has(BluetoothGattCharacteristic.PROPERTY_SIGNED_WRITE, "signed-write")
            has(BluetoothGattCharacteristic.PROPERTY_EXTENDED_PROPS, "extended")
            val descs = JSArray()
            c.descriptors.forEach { descs.put(it.uuid.toString()) }
            rows.put(
                JSObject().put("serviceUuid", s.uuid.toString()).put("charUuid", c.uuid.toString())
                    .put("properties", props).put("descriptors", descs)
            )
        }
        put("rows", rows)
    }

    /** One GATT operation at a time: Android silently drops overlapping requests. */
    private fun nextOp() {
        val g = gatt ?: return
        val op = ops.removeFirstOrNull() ?: run { currentOp = null; return }
        currentOp = op
        ui.postDelayed(opTimeout, 8000)
        try {
            when (op) {
                is Op.Read -> if (!g.readCharacteristic(op.c)) { fail("read rejected"); finishOp() }
                is Op.Write -> {
                    val ok = if (Build.VERSION.SDK_INT >= 33) {
                        g.writeCharacteristic(op.c, op.bytes, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) ==
                            android.bluetooth.BluetoothStatusCodes.SUCCESS
                    } else {
                        @Suppress("DEPRECATION") run {
                            op.c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                            op.c.value = op.bytes
                            g.writeCharacteristic(op.c)
                        }
                    }
                    if (!ok) { fail("write rejected"); finishOp() }
                }
                is Op.Subscribe -> {
                    g.setCharacteristicNotification(op.c, true)
                    val cccd = op.c.getDescriptor(CCCD)
                    if (cccd == null) { fail("no CCCD descriptor"); finishOp(); return }
                    val v = if (op.c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0)
                        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                    val ok = if (Build.VERSION.SDK_INT >= 33) {
                        g.writeDescriptor(cccd, v) == android.bluetooth.BluetoothStatusCodes.SUCCESS
                    } else {
                        @Suppress("DEPRECATION") run { cccd.value = v; g.writeDescriptor(cccd) }
                    }
                    if (!ok) { fail("subscribe rejected"); finishOp() }
                }
            }
        } catch (e: SecurityException) {
            fail("missing permission: ${e.message}"); finishOp()
        }
    }

    private fun finishOp() {
        ui.removeCallbacks(opTimeout)
        currentOp = null
        nextOp()
    }

    override fun onDestroy() {
        stopScan()
        closeServer()
        gatt?.close()
        gatt = null
    }

    companion object {
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private val TARGET_SERVICE: UUID = UUID.fromString("01ff0100-ba5e-f4ee-5ca1-eb1e5e4b1ce0")
        private val TARGET_CHAR: UUID = UUID.fromString("01ff0101-ba5e-f4ee-5ca1-eb1e5e4b1ce0")
        private val ALLOWED_OPCODES = setOf(0x21, 0x20, 0x50, 0x03, 0x30) // hello, PIN, time sync, two post-pairing queries. Nothing else may ever be written.

        /** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as in the official app's framing helper. */
        fun crc16(b: ByteArray, len: Int): Int {
            var crc = 0xFFFF
            for (i in 0 until len) {
                crc = crc xor ((b[i].toInt() and 0xFF) shl 8)
                repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xFFFF else (crc shl 1) and 0xFFFF }
            }
            return crc
        }

        /** Returns the 20 frame bytes if [hex] is a well-formed, CRC-correct, allow-listed frame; otherwise null. */
        fun validateFrame(hex: String): ByteArray? {
            val clean = hex.filter { it.isLetterOrDigit() }
            if (clean.length != 40 || !clean.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
            val b = ByteArray(20) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
            if ((b[0].toInt() and 0xFF) !in ALLOWED_OPCODES) return null
            val crc = crc16(b, 18)
            if (b[18].toInt() and 0xFF != crc shr 8 || b[19].toInt() and 0xFF != crc and 0xFF) return null
            return b
        }
    }
}
