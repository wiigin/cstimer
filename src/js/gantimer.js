/**
 * 
 * Driver for GAN Smart Timer using Web Bluetooth API
 * Credits: Andy Fedotov, https://github.com/afedotov
 * Based on modern typescript version of this stuff: https://github.com/afedotov/gan-web-bluetooth
 * 
 */

"use strict";

// Possible event states of GAN Smart Timer
var GanTimerState = {};
GanTimerState[GanTimerState["DISCONNECT"] = 0] = "DISCONNECT";  // Fired when timer is disconnected from bluetooth
GanTimerState[GanTimerState["GET_SET"] = 1] = "GET_SET";		// Grace delay is expired and timer is ready to start
GanTimerState[GanTimerState["HANDS_OFF"] = 2] = "HANDS_OFF";	// Hands removed from the timer before grace delay expired
GanTimerState[GanTimerState["RUNNING"] = 3] = "RUNNING";		// Timer is running
GanTimerState[GanTimerState["STOPPED"] = 4] = "STOPPED";		// Timer is stopped, this event includes recorded time
GanTimerState[GanTimerState["IDLE"] = 5] = "IDLE";			  // Timer is reset and idle
GanTimerState[GanTimerState["HANDS_ON"] = 6] = "HANDS_ON";	  // Hands are placed on the timer
GanTimerState[GanTimerState["FINISHED"] = 7] = "FINISHED";	  // Timer moves to this state immediately after STOPPED

var GanTimerDriver = execMain(function () {

	var GAN_TIMER_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
	var GAN_TIMER_STATE_CHARACTERISTIC = '0000fff5-0000-1000-8000-00805f9b34fb';

	var stateUpdateCallback;   // callback function invoked on timer state update
	var stateCharacteristic;   // timer state bluetooth characteristic object

	// dump DataView object as hex string
	function hexdump(dataView) {
		var hexdata = [];
		if (dataView) {
			for (var i = 0; i < dataView.byteLength; i++) {
				hexdata.push(dataView.getUint8(i).toString(16).padStart(2, '0'));
			}
		}
		return hexdata.join(" ");
	}

	// Construct time object
	function makeTime(min, sec, msec) {
		return {
			minutes: min,
			seconds: sec,
			milliseconds: msec,
			asTimestamp: 60000 * min + 1000 * sec + msec
		};
	}

	// Construct time object from raw bluetooth event data
	function makeTimeFromRaw(data, offset) {
		var min = data.getUint8(offset);
		var sec = data.getUint8(offset + 1);
		var msec = data.getUint16(offset + 2, true);
		return makeTime(min, sec, msec);
	}

	// build event from raw data
	function buildTimerEvent(data) {
		var evt = {
			state: data.getUint8(3)
		};
		if (evt.state == GanTimerState.STOPPED) {
			evt.recordedTime = makeTimeFromRaw(data, 4);
		}
		return evt;
	}

	// Calculate ArrayBuffer checksum using CRC-16/CCIT-FALSE algorithm variation
	function crc16ccit(buff) {
		var dataView = new DataView(buff);
		var crc = 0xFFFF;
		for (var i = 0; i < dataView.byteLength; ++i) {
			crc ^= dataView.getUint8(i) << 8;
			for (var j = 0; j < 8; ++j) {
				crc = (crc & 0x8000) > 0 ? (crc << 1) ^ 0x1021 : crc << 1;
			}
		}
		return crc & 0xFFFF;
	}

	// Ensure received bluetooth event has valid data: check data magic and CRC
	function validateEventData(data) {
		try {
			if (!data || data.byteLength == 0 || data.getUint8(0) != 0xFE) {
				return false;
			}
			var dataCRC = data.getUint16(data.byteLength - 2, true);
			var calculatedCRC = crc16ccit(data.buffer.slice(2, data.byteLength - 2));
			return dataCRC == calculatedCRC;
		} catch (err) {
			return false;
		}
	}

	// handle value update of the timer state bluetooth characteristic
	function handleStateCharacteristicUpdate(event) {
		var data = event.target.value;
		if (validateEventData(data)) {
			if (typeof stateUpdateCallback == 'function') {
				stateUpdateCallback(buildTimerEvent(data));
			}
		} else {
			console.log("GanTimerDriver: Invalid event data received from Timer: " + hexdump(data));
		}
	}

	// handle disconnection when timer is is powered off or something like that
	function handleUnexpectedDisconnection() {
		if (stateCharacteristic) {
			stateCharacteristic.removeEventListener('characteristicvaluechanged', handleStateCharacteristicUpdate);
			stateCharacteristic = undefined;
		}
		if (typeof stateUpdateCallback == 'function') {
			stateUpdateCallback({ state: GanTimerState.DISCONNECT });
		}
	}

	// perform connection to bluetooth device and characteristic
	function connectImpl() {

		if (!window.navigator.bluetooth) {
			return Promise.reject("Bluetooth API is not supported by this browser. Try fresh Chrome version!");
		}
		var chkAvail = Promise.resolve(true);
		if (window.navigator.bluetooth.getAvailability) {
			chkAvail = window.navigator.bluetooth.getAvailability();
		}

		return chkAvail.then(function(available) {
			if (!available)
				return Promise.reject("Bluetooth is not available. Ensure HTTPS access, and check bluetooth is enabled on your device");
		}).then(function () {
			return navigator.bluetooth.requestDevice({
				filters: [
					{ namePrefix: "GAN" },
					{ namePrefix: "gan" },
					{ namePrefix: "Gan" }
				],
				optionalServices: [GAN_TIMER_SERVICE]
			});
		}).then(function (device) {
			device.addEventListener('gattserverdisconnected', handleUnexpectedDisconnection);
			return device.gatt.connect();
		}).then(function (gatt) {
			return gatt.getPrimaryService(GAN_TIMER_SERVICE);
		}).then(function (service) {
			return service.getCharacteristic(GAN_TIMER_STATE_CHARACTERISTIC);
		}).then(function (characteristic) {
			stateCharacteristic = characteristic;
			stateCharacteristic.addEventListener('characteristicvaluechanged', handleStateCharacteristicUpdate);
			stateCharacteristic.startNotifications();
		});

	}

	// manual disconnect from timer device
	function disconnectImpl() {
		if (stateCharacteristic) {
			stateCharacteristic.service.device.removeEventListener('gattserverdisconnected', handleUnexpectedDisconnection);
			stateCharacteristic.removeEventListener('characteristicvaluechanged', handleStateCharacteristicUpdate);
			return stateCharacteristic.stopNotifications().then(function() {
				stateCharacteristic.service.device.gatt.disconnect();
				stateCharacteristic = undefined;
			});
		} else {
			return Promise.resolve();
		}
	}

	function setStateUpdateCallbackImpl(callback) {
		stateUpdateCallback = callback;
	}

	return {
		connect: connectImpl, // connect to timer device
		disconnect: disconnectImpl, // disconnect from timer device
		setStateUpdateCallback: setStateUpdateCallbackImpl // register callback invoked on timer state update
	};

});
