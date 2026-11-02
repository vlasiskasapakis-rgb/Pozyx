/**
  Pozyx auto-calibration + positioning
  Based on the Pozyx ready_to_range and ready_to_localize tutorials.

  What it does:
    1. Measures the distances between all anchors (they range each other).
    2. Calculates the x,y position of every anchor from those distances
       and the heights you typed in (any number of anchors from 3 up).
    3. Sends the anchor positions to the tag on the Arduino.
    4. Starts positioning and prints x, y, z of the tag, with a timestamp.

  How to use:
    - Place 3 or more anchors around the room, powered on.
    - After a reset there is a countdown (calibration_delay_s) so you can
      leave the room before the anchors measure each other.
    - Fill in num_anchors, the anchor IDs and their heights below.
    - Upload, open the Serial Monitor at 115200 baud.
    - Press the red reset button on the Arduino to calibrate again
      (do this whenever you move an anchor).

  Coordinate system (automatic):
    - (0,0,0) is the floor directly below anchor A1
    - the x axis points from A1 towards A2
    - A3 is on the positive y side
    - z is the height above the floor

  Timestamps (real date and time):
    - The Arduino has no clock that knows the date, only a stopwatch
      (millis() = ms since it started). It marks every position with it,
      and also sends a CLOCK line every loop.
    - The web page uses the CLOCK lines to link the stopwatch to the
      laptop's clock, and saves every position with the real date and
      time (unix_ms and time columns). Other apps on the same laptop
      use the same clock, so you can line the data up with them later.

  Tips:
    - A1, A2 and A3 must NOT be in a straight line.
    - Anchors should see each other (no walls or big metal objects between them).
    - 3D (x, y and the tag's height) needs 4+ anchors at CLEARLY different
      heights. With anchors at about the same height the sketch uses 2.5D:
      it works out x, y only and uses the fixed tag_height below
      (positioning_mode chooses this; automatic by default).
    - More than 4 anchors: the Pozyx picks the best ones for each position.
*/

#include <Pozyx.h>
#include <Pozyx_definitions.h>
#include <Wire.h>

////////////////////////////////////////////////
////////////////// PARAMETERS //////////////////
////////////////////////////////////////////////

const uint8_t num_anchors = 5;     // 3 or more

// Anchor IDs in order A1, A2, A3, ... (the 0x... code on each green board), num_anchors of them
uint16_t anchors[num_anchors] = {0x6a67, 0x6a4b, 0x6a71, 0x6a70, 0x6a45};

// Height of each anchor above the floor in mm (measure to the antenna), in the same order.
// For 3D, use CLEARLY different heights (e.g. high, low, high, low).
int32_t heights[num_anchors]  = {600, 600, 600, 600, 600};

// 0 = automatic: 3D when there are 4+ anchors whose heights differ by at least
//     min_height_spread mm, otherwise 2.5D.  2 = always 2.5D.  3 = always 3D.
const uint8_t positioning_mode = 0;
const int32_t min_height_spread = 500;

// Height of the tag above the floor in mm (how high it is carried). Used in 2.5D,
// where only x and y are worked out.
int32_t tag_height = 1000;

// Tags to track: green boards powered by a battery pack (no Arduino needed).
// Put their IDs here. You can add more, e.g. {0x6a01, 0x6a02}.
const uint8_t num_tags = 1;
uint16_t tags[] = {0x6a77};

// Also track the board that sits on the Arduino itself?
// false = the Arduino board only acts as the "master" next to your laptop.
bool track_local = false;

// Seconds to wait before the anchors measure each other, so you can leave the room
// (people near the anchors block the signal and spoil the calibration). 0 = no wait.
const uint16_t calibration_delay_s = 5;

// How many distance measurements to average per direction for each pair
const uint8_t samples_per_direction = 10;

uint8_t algorithm = POZYX_POS_ALG_UWB_ONLY;
uint8_t ranging_protocol = POZYX_RANGE_PROTOCOL_PRECISION;

////////////////////////////////////////////////

int32_t anchors_x[num_anchors];
int32_t anchors_y[num_anchors];
float dist[num_anchors][num_anchors];   // measured 3D distances between anchors, in mm
uint8_t dimension;

void setup() {
  Serial.begin(115200);

  if (Pozyx.begin() == POZYX_FAILURE) {
    Serial.println(F("ERROR: Unable to connect to POZYX shield"));
    Serial.println(F("Reset required"));
    delay(100);
    abort();
  }

  Serial.println(F("------------POZYX AUTO POSITIONING------------"));
  dimension = chooseDimension();
  if (calibration_delay_s > 0) {
    Serial.print(F("Leave the room now: measuring the anchors in "));
    Serial.print(calibration_delay_s);
    Serial.println(F(" s"));
    for (uint16_t s = calibration_delay_s; s > 0; s--) {
      Serial.print(F("  "));
      Serial.println(s);
      delay(1000);
    }
  }
  Serial.println(F("Step 1: measuring distances between anchors..."));

  for (uint8_t i = 0; i < num_anchors; i++) {
    Pozyx.setRangingProtocol(ranging_protocol, anchors[i]);
  }

  for (uint8_t i = 0; i < num_anchors; i++) {
    for (uint8_t j = i + 1; j < num_anchors; j++) {
      float d = measurePair(anchors[i], anchors[j]);
      if (d <= 0) {
        Serial.print(F("ERROR: could not measure between A"));
        Serial.print(i + 1);
        Serial.print(F(" and A"));
        Serial.println(j + 1);
        Serial.println(F("Check the IDs, power and line of sight, then press reset."));
        delay(100);
        abort();
      }
      dist[i][j] = d;
      dist[j][i] = d;
      Serial.print(F("  A"));
      Serial.print(i + 1);
      Serial.print(F(" <-> A"));
      Serial.print(j + 1);
      Serial.print(F(": "));
      Serial.print(d, 0);
      Serial.println(F(" mm"));
    }
  }

  Serial.println(F("Step 2: calculating anchor positions..."));
  if (!computeAnchorPositions()) {
    Serial.println(F("ERROR: anchor layout not usable."));
    Serial.println(F("A1, A2 and A3 may be in a straight line, or a distance is wrong."));
    delay(100);
    abort();
  }

  for (uint8_t i = 0; i < num_anchors; i++) {
    Serial.print(F("  A"));
    Serial.print(i + 1);
    Serial.print(F(" (0x"));
    Serial.print(anchors[i], HEX);
    Serial.print(F("): x="));
    Serial.print(anchors_x[i]);
    Serial.print(F(" y="));
    Serial.print(anchors_y[i]);
    Serial.print(F(" z="));
    Serial.println(heights[i]);
  }
  printCopyableLines();
  printAnchorLines();

  Serial.println(F("Step 3: sending anchor positions to the tags..."));
  if (track_local) {
    Pozyx.clearDevices();
    setAnchors(NULL);
    if (num_anchors > 4) Pozyx.setSelectionOfAnchors(POZYX_ANCHOR_SEL_AUTO, num_anchors);
    Pozyx.setPositionAlgorithm(algorithm, dimension);
  }
  for (uint8_t t = 0; t < num_tags; t++) {
    Pozyx.setRangingProtocol(ranging_protocol, tags[t]);
    Pozyx.clearDevices(tags[t]);
    setAnchors(tags[t]);
    if (num_anchors > 4) Pozyx.setSelectionOfAnchors(POZYX_ANCHOR_SEL_AUTO, num_anchors, tags[t]);
    if (Pozyx.setPositionAlgorithm(algorithm, dimension, tags[t]) == POZYX_SUCCESS) {
      Serial.print(F("  tag 0x"));
      Serial.print(tags[t], HEX);
      Serial.println(F(" ready"));
    } else {
      Serial.print(F("  WARNING: could not reach tag 0x"));
      Serial.print(tags[t], HEX);
      Serial.println(F(" (is it powered on and in range?)"));
    }
  }

  Serial.print(F("Step 4: positioning started in "));
  Serial.print(dimension == POZYX_3D ? F("3D") : F("2.5D (z = tag_height)"));
  Serial.println(F(" (x, y, z in mm, time in ms since start)"));
  Serial.println();
  delay(500);
}

void loop() {
  // Re-send the anchor positions now and then, so the web page always has them
  static uint16_t loop_count = 0;
  if (++loop_count >= 50) {
    loop_count = 0;
    printAnchorLines();
  }

  printClock();

  // The timestamp is the middle of each measurement (a measurement takes some ms).
  if (track_local) {
    coordinates_t position;
    uint32_t start = millis();
    int status = Pozyx.doPositioning(&position, dimension, tag_height, algorithm);
    printPosition(NULL, status, position, start + (millis() - start) / 2);
  }
  for (uint8_t t = 0; t < num_tags; t++) {
    coordinates_t position;
    uint32_t start = millis();
    int status = Pozyx.doRemotePositioning(tags[t], &position, dimension, tag_height, algorithm);
    printPosition(tags[t], status, position, start + (millis() - start) / 2);
  }
}

// Prints one line per measurement, in a format the web page reads:
//   POS,<tag id>,<x>,<y>,<z>,<time>     (mm, time = ms since the Arduino started)
//   ERR,<tag id>,<time>
void printPosition(uint16_t id, int status, coordinates_t &position, uint32_t timestamp) {
  if (status == POZYX_SUCCESS) {
    Serial.print(F("POS,"));
  } else {
    Serial.print(F("ERR,"));
  }
  if (id == NULL) {
    Serial.print(F("LOCAL"));
  } else {
    Serial.print(id, HEX);
  }
  if (status == POZYX_SUCCESS) {
    Serial.print(',');
    Serial.print(position.x);
    Serial.print(',');
    Serial.print(position.y);
    Serial.print(',');
    Serial.print(position.z);
  }
  Serial.print(',');
  Serial.println(timestamp);
}

// Prints the Arduino time for the web page, which links it to the laptop's real clock:
//   CLOCK,<time>                  (ms since the Arduino started)
// It first waits until earlier lines are sent, so this line leaves right away
// and the moment it arrives on the laptop is accurate.
void printClock() {
  Serial.flush();
  Serial.print(F("CLOCK,"));
  Serial.println(millis());
}

// Prints the anchor positions for the web page:
//   ANCHOR,<id>,<x>,<y>,<z>       (mm)
void printAnchorLines() {
  for (uint8_t i = 0; i < num_anchors; i++) {
    Serial.print(F("ANCHOR,"));
    Serial.print(anchors[i], HEX);
    Serial.print(',');
    Serial.print(anchors_x[i]);
    Serial.print(',');
    Serial.print(anchors_y[i]);
    Serial.print(',');
    Serial.println(heights[i]);
  }
}

// Measures the distance between two anchors in both directions and averages it.
// Returns -1 if no measurement succeeded.
float measurePair(uint16_t a, uint16_t b) {
  float sum = 0;
  uint16_t count = 0;

  for (uint8_t dir = 0; dir < 2; dir++) {
    uint16_t from = (dir == 0) ? a : b;
    uint16_t to   = (dir == 0) ? b : a;
    uint8_t good = 0;

    for (uint8_t attempt = 0; attempt < samples_per_direction * 3 && good < samples_per_direction; attempt++) {
      device_range_t range;
      if (Pozyx.doRemoteRanging(from, to, &range) == POZYX_SUCCESS && range.distance > 0) {
        sum += range.distance;
        count++;
        good++;
      }
      delay(20);
    }
  }

  if (count == 0) return -1;
  return sum / count;
}

// 3D needs 4+ anchors at clearly different heights; otherwise 2.5D (x, y at tag_height)
uint8_t chooseDimension() {
  if (positioning_mode == 2) return POZYX_2_5D;
  if (positioning_mode == 3) return POZYX_3D;
  int32_t lo = heights[0], hi = heights[0];
  for (uint8_t i = 1; i < num_anchors; i++) {
    if (heights[i] < lo) lo = heights[i];
    if (heights[i] > hi) hi = heights[i];
  }
  if (num_anchors >= 4 && hi - lo >= min_height_spread) {
    Serial.println(F("Mode: 3D (anchor heights differ enough)"));
    return POZYX_3D;
  }
  Serial.print(F("Mode: 2.5D, tag height fixed at "));
  Serial.print(tag_height);
  Serial.println(F(" mm (anchor heights too similar for 3D)"));
  return POZYX_2_5D;
}

// Squared horizontal distance between anchors i and j (removes the height difference).
float horiz2(uint8_t i, uint8_t j) {
  float dz = (float)(heights[i] - heights[j]);
  float h2 = dist[i][j] * dist[i][j] - dz * dz;
  return (h2 > 0) ? h2 : 0;
}

bool computeAnchorPositions() {
  // A1 at the origin
  anchors_x[0] = 0;
  anchors_y[0] = 0;

  // A2 on the x axis
  float d12 = sqrt(horiz2(0, 1));
  if (d12 < 100) return false;
  anchors_x[1] = lround(d12);
  anchors_y[1] = 0;

  // A3 on the positive y side
  float x3 = (horiz2(0, 2) - horiz2(1, 2) + d12 * d12) / (2 * d12);
  float y3sq = horiz2(0, 2) - x3 * x3;
  if (y3sq < 100.0 * 100.0) return false;   // A1, A2, A3 almost in a line
  float y3 = sqrt(y3sq);
  anchors_x[2] = lround(x3);
  anchors_y[2] = lround(y3);

  // A4 and beyond: x from A1 and A2 as for A3, then pick the side (+y or -y)
  // that best matches the distances to all anchors placed so far (except A1, A2)
  for (uint8_t i = 3; i < num_anchors; i++) {
    float xi = (horiz2(0, i) - horiz2(1, i) + d12 * d12) / (2 * d12);
    float yisq = horiz2(0, i) - xi * xi;
    float yi = (yisq > 0) ? sqrt(yisq) : 0;

    float e_pos = 0, e_neg = 0;
    for (uint8_t j = 2; j < i; j++) {
      float dx = xi - anchors_x[j];
      float target = sqrt(horiz2(j, i));
      e_pos += sq(sqrt(dx * dx + sq(yi - anchors_y[j])) - target);
      e_neg += sq(sqrt(dx * dx + sq(-yi - anchors_y[j])) - target);
    }
    anchors_x[i] = lround(xi);
    anchors_y[i] = lround((e_pos <= e_neg) ? yi : -yi);
  }
  return true;
}

// Stores the anchor positions on a device (NULL = the board on the Arduino).
void setAnchors(uint16_t device_id) {
  for (uint8_t i = 0; i < num_anchors; i++) {
    device_coordinates_t anchor;
    anchor.network_id = anchors[i];
    anchor.flag = 0x1;
    anchor.pos.x = anchors_x[i];
    anchor.pos.y = anchors_y[i];
    anchor.pos.z = heights[i];
    Pozyx.addDevice(anchor, device_id);
  }
}

// Prints the anchor positions in a form you can paste into ready_to_localize.
void printCopyableLines() {
  Serial.println(F("  (for ready_to_localize, if you want to skip calibration next time:)"));
  Serial.print(F("  int32_t anchors_x[num_anchors] = {"));
  for (uint8_t i = 0; i < num_anchors; i++) {
    Serial.print(anchors_x[i]);
    if (i < num_anchors - 1) Serial.print(F(", "));
  }
  Serial.println(F("};"));
  Serial.print(F("  int32_t anchors_y[num_anchors] = {"));
  for (uint8_t i = 0; i < num_anchors; i++) {
    Serial.print(anchors_y[i]);
    if (i < num_anchors - 1) Serial.print(F(", "));
  }
  Serial.println(F("};"));
}
