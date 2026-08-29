# Hermes Chat Bottom Safe Area Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Keep every Hermes chat bubble inside a dedicated viewport above the 40 px bottom action bar, and return to the newest message only when the message list changes, without changing any button behavior.

**Architecture:** Put the screen geometry and message-change decision in a small host-testable header. `HermesScene` consumes that contract to create two non-overlapping LVGL regions: a 236 px chat viewport and a 40 px opaque action bar. Message rendering performs one layout pass and one scroll-to-bottom operation after rebuilding the complete list.

**Tech Stack:** C++17, LVGL 9.5, ESP-IDF 5.5.2, ESP32-S3, SSD2683 e-paper display, host `c++` contract tests.

## Global Constraints

- Preserve the existing key mapping: short Up/Down continue to adjust volume; no page-turning behavior is added.
- Preserve existing footer wording for idle and recording states.
- Do not allow chat children or bubbles to draw into `y=260..299`.
- State, battery, Wi-Fi, time, or footer-text changes must not rebuild messages or reset the chat scroll position.
- A changed message count or changed message key must rebuild the list and scroll exactly once to the latest position.
- Deployment may write only the factory app at `0x10000`; preserve bootloader, partition table, NVS, `phy_init`, and LittleFS/storage.

## Task 1: Add a failing host contract test

**Files:**

- Create: `firmware/tests/hermes_layout_test.cc`
- Create after the red test: `firmware/main/scenes/hermes/hermes_layout.h`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the geometry and refresh-policy test before production code**

  The test includes `hermes_layout.h` and asserts:

  - 300 px screen minus 24 px status bar minus 40 px action bar produces `y=24, height=236`.
  - action bar is `y=260, height=40`.
  - the two rectangles do not overlap and terminate exactly at screen height.
  - equal message count/key means no rebuild.
  - count or key change means rebuild.
  - Hermes state is intentionally absent from the rebuild decision.

- [ ] **Step 2: Run the host test and confirm the expected red state**

  Run:

  ```bash
  c++ -std=c++17 -Ifirmware/main firmware/tests/hermes_layout_test.cc -o /tmp/hermes_layout_test && /tmp/hermes_layout_test
  ```

  Expected: compilation fails because `scenes/hermes/hermes_layout.h` does not exist yet.

- [ ] **Step 3: Implement the smallest pure layout contract**

  Add `hermes_layout.h` with:

  - `kBottomActionBarHeight = 40`
  - a small `Rect` value type
  - `ChatViewport(screen_height, status_height)`
  - `ActionBar(screen_height)`
  - `Overlaps(a, b)`
  - `MessagesChanged(rendered_count, rendered_key, next_count, next_key)` using `std::string_view`

- [ ] **Step 4: Run the host test and confirm green**

  Run the same compile-and-execute command. Expected: exit 0 and a success line.

- [ ] **Step 5: Put the new test in CI**

  Add a firmware host-contract step to `.github/workflows/ci.yml` that compiles and runs `firmware/tests/hermes_layout_test.cc` with C++17.

## Task 2: Isolate the LVGL chat viewport from the footer

**Files:**

- Modify: `firmware/main/scenes/hermes/hermes_scene.h`
- Modify: `firmware/main/scenes/hermes/hermes_scene.cc`

- [ ] **Step 1: Add an explicit action-bar object**

  Add `action_bar_` to the scene. Create it at `y=260`, height `40`, with opaque white background, no border, no padding, and no scrolling. Make `hint_label_` a centered child with a bounded width.

- [ ] **Step 2: Apply the tested chat viewport geometry**

  Position `chat_area_` at `y=24`, height `236`, and size `chat_content_` to the same viewport. Keep vertical scrolling enabled and horizontal scrolling disabled.

- [ ] **Step 3: Remove per-bubble scrolling**

  Delete `lv_obj_scroll_to_view_recursive(row, LV_ANIM_OFF)` from `AppendBubble()` so building a long history cannot repeatedly change the viewport.

- [ ] **Step 4: Rebuild only when messages change**

  Replace the state-sensitive `RenderMessages()` condition with `MessagesChanged(...)`. Remove the obsolete rendered-state cache member. Battery, Wi-Fi, recording, thinking, playing, and error state transitions must leave the current chat offset untouched when the messages are unchanged.

- [ ] **Step 5: Scroll once after the complete message list is laid out**

  After all bubbles are appended:

  1. call `lv_obj_update_layout(chat_content_)`;
  2. compute the maximum vertical position from current scroll Y plus `lv_obj_get_scroll_bottom()`;
  3. call `lv_obj_scroll_to_y(..., LV_ANIM_OFF)` exactly once.

- [ ] **Step 6: Check object lifecycle**

  Reset `action_bar_` in `OnExit()`. Ensure footer visibility remains controlled through `hint_label_` while the opaque action-bar background continues to protect the safe area.

## Task 3: Verify source behavior and firmware build

**Files:**

- Modify only if documentation is needed: `firmware/README.md`

- [ ] **Step 1: Run host contract tests**

  Run:

  ```bash
  c++ -std=c++17 -Ifirmware/main firmware/tests/hermes_layout_test.cc -o /tmp/hermes_layout_test && /tmp/hermes_layout_test
  c++ -std=c++17 -Ifirmware/main firmware/tests/hermes_limits_test.cc -o /tmp/hermes_limits_test && /tmp/hermes_limits_test
  ```

- [ ] **Step 2: Run formatting and static checks relevant to changed files**

  Check the diff and use the repository's formatting/lint commands where applicable. Confirm there are no footer copy or key-handler changes.

- [ ] **Step 3: Build the complete firmware with ESP-IDF 5.5.x**

  From the repository root:

  ```bash
  . ./tools/export_esp_idf.sh >/tmp/esp_idf_export.log && idf.py -C firmware build
  ```

  Expected: successful app build, partition-size check, and generated `firmware/build/slate.bin`.

- [ ] **Step 4: Inspect the binary layout before any device write**

  Confirm the factory app offset remains `0x10000`, record the new image size and SHA-256, and verify the image fits the factory partition.

- [ ] **Step 5: Commit the tested implementation**

  Commit only the safe-area implementation, its regression test, CI wiring, and directly related documentation using a Chinese Conventional Commit message.

## Task 4: Factory-only device deployment with rollback evidence

**Files:**

- Read: `firmware/partitions.csv`
- Read/write device: `/dev/cu.usbmodem2101`
- Create: an explicit timestamped backup directory under `/tmp`

- [ ] **Step 1: Resolve and validate the exact serial target**

  Confirm `/dev/cu.usbmodem2101` exists and identify the connected ESP32-S3 before writing.

- [ ] **Step 2: Capture pre-flash rollback and preservation evidence**

  Read and hash:

  - the existing factory app over the exact new-image length;
  - bootloader;
  - partition table;
  - NVS;
  - `phy_init`;
  - full LittleFS/storage partition.

- [ ] **Step 3: Write only the new factory application**

  Use `esptool` to write `firmware/build/slate.bin` at `0x10000`. Do not run an erase, full `idf.py flash`, OTA partition write, or filesystem write.

- [ ] **Step 4: Perform exact readback verification**

  Read back the factory range for the exact new-image length and compare its SHA-256 byte-for-byte with `firmware/build/slate.bin`.

- [ ] **Step 5: Prove protected partitions did not change**

  Re-read and compare the hashes for bootloader, partition table, NVS, `phy_init`, and full LittleFS/storage. Retain the pre-flash factory image as the rollback artifact.

- [ ] **Step 6: Confirm the new application boots**

  Read the serial log after reset and verify the Hermes scene initializes without crash, boot loop, or LVGL assertion.

## Task 5: Real-device acceptance and publication

- [ ] **Step 1: Exercise a long Hermes conversation**

  Generate enough messages to overflow the 236 px chat viewport. Confirm the newest reply is visible after arrival.

- [ ] **Step 2: Visually verify the footer safe area**

  Confirm no chat border, text, or bubble background enters `y=260..299`, including long multi-line assistant replies.

- [ ] **Step 3: Re-check the unchanged key contract**

  Confirm Up/Down still adjust volume, Enter still starts/stops chat, double Enter returns, and long Enter opens settings.

- [ ] **Step 4: Push only after local and device proof passes**

  Push the implementation commits to `origin/master`, monitor the triggered CI, and report separately:

  - host-test proof;
  - full ESP-IDF build proof;
  - factory-app readback proof;
  - protected-partition proof;
  - live visual acceptance proof.
