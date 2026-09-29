/** CRC-16/MODBUS: init 0xFFFF, reflected poly 0xA001, no final xor. */
export function crc16(bytes, length = bytes.length) {
  let crc = 0xFFFF;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i] & 0xFF;
    for (let b = 0; b < 8; b++) {
      const lsb = crc & 1;
      crc >>>= 1;
      if (lsb) crc ^= 0xA001;
    }
  }
  return crc & 0xFFFF;
}
