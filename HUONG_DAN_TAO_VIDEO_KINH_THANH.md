# HƯỚNG DẪN TẠO VIDEO KINH THÁNH BẰNG FRAMEWEAVER
*(Dành cho Facebook Reels, TikTok, YouTube Shorts - Chuẩn tỷ lệ dọc 9:16)*

Tài liệu này cung cấp kịch bản mẫu hoàn chỉnh và hướng dẫn chi tiết từng bước để bạn tạo video ngắn điện ảnh về chủ đề **"Chúa Giêsu Dẹp Yên Bão Tố"** (Biển hồ Galilee - Phúc âm Mác-cô 4:35-41).

---

## 🌟 TỔNG QUAN DỰ ÁN MẪU
- **Chủ đề:** Chúa Giêsu dẹp yên bão tố trên biển hồ Galilee.
- **Thời lượng:** ~35 – 45 giây (Gồm 5 phân cảnh điện ảnh).
- **Định dạng:** Video dọc 9:16 (1080x1920) chuẩn Reels/TikTok.
- **Phong cách hình ảnh:** Điện ảnh Hollywood sử thi (*Cinematic Biblical Epic*), ánh sáng vàng thiêng liêng (*divine god rays*).

---

## 📋 BƯỚC 1: TẠO DỰ ÁN TRÊN FRAMEWEAVER

1. Mở trình duyệt vào Google Flow: `https://flow.google.com/` và tạo 1 Project mới.
2. Sao chép đường link dự án trên thanh địa chỉ (hoặc mã UUID của dự án).
3. Mở Dashboard FrameWeaver: `http://localhost:5173/projects`.
4. Bấm nút **"Thêm dự án"** (Add project):
   - **Tên dự án:** `Chúa Dẹp Yên Bão Tố - Biển Hồ Galilee`
   - **Link Google Flow:** Dán link hoặc UUID bạn vừa copy.
   - **Chất liệu hình ảnh (Material):** Chọn `realistic` (Chân thực điện ảnh).
5. Bấm **Xác nhận tạo**.

---

## 👤 BƯỚC 2: TẠO NHÂN VẬT THAM CHIẾU (REFERENCE ENTITY)
*Mục đích: Giữ khuôn mặt, râu tóc và trang phục của Chúa Giêsu đồng nhất 100% qua tất cả các cảnh.*

1. Trong trang dự án, chuyển sang tab **Characters** (Nhân vật) hoặc mở **Story Studio**.
2. Thêm nhân vật mới:
   - **Tên nhân vật (Name):** `Dang Cuu The` *(hoặc `Teacher` - theo quy tắc không dùng tên trực tiếp để tránh kích hoạt bộ lọc bảo vệ tên người nổi tiếng của AI)*.
   - **Mô tả ngoại hình (Image Prompt):**
     ```text
     Cinematic biblical portrait of a compassionate 33-year-old Middle Eastern man with gentle warm brown eyes, wavy shoulder-length dark brown hair, neat beard, wearing traditional first-century off-white textured linen tunic with a simple crimson drape over shoulder. Soft golden divine light, serene peaceful expression, 8k resolution, cinematic lighting, masterpiece.
     ```
3. Bấm **Tạo ảnh tham chiếu** (Generate Reference Image). AI sẽ vẽ ảnh chân dung mẫu.

---

## 🎬 BƯỚC 3: KỊCH BẢN PHÂN CẢNH CHI TIẾT (COPY & PASTE)

Vào tab **Videos** -> Tạo video mới (chọn định dạng `VERTICAL`), sau đó thêm 5 phân cảnh sau:

### Phân cảnh 1: Giông bão ập đến (Hook - Gây cấn)
- **Thời lượng:** 8 giây
- **Góc máy:** Quay góc rộng toàn cảnh (*Wide cinematic shot*)
- **Prompt hình ảnh (Scene Prompt):**
  ```text
  A fragile ancient wooden fishing boat rocking violently on massive dark stormy sea waves at night, dark tempest clouds, lightning flashing in the stormy sky, dramatic water splashes, cinematic epic lighting, hyper-realistic, photorealistic, 8k.
  ```
- **Prompt video (Veo Video Prompt):**
  ```text
  0-3s: Massive dark ocean waves crash against the ancient wooden boat, rain pouring fiercely. 3-6s: Lightning illuminates the dark clouds as the boat pitches violently on towering waves. 6-8s: The boat leans precariously as fierce sea foam sprays across the deck.
  ```
- **Lời dẫn thuyết minh (Narrator Text tiếng Việt):**
  ```text
  Đêm ấy, một trận cuồng phong bất ngờ ập xuống biển hồ. Những con sóng dữ dội chồm lên, như muốn nuốt chửng con thuyền nhỏ bé.
  ```

---

### Phân cảnh 2: Sự bình an giữa bão tố
- **Thời lượng:** 8 giây
- **Góc máy:** Cận cảnh (*Medium close-up shot*)
- **Nhân vật:** Chọn `Dang Cuu The`
- **Prompt hình ảnh (Scene Prompt):**
  ```text
  Inside the wooden boat, a peaceful man resting serenely with his head on a cushion at the stern, completely undisturbed by the storm, water splashing around, calm and serene expression, warm subtle divine glow, cinematic lighting.
  ```
- **Prompt video (Veo Video Prompt):**
  ```text
  0-3s: Camera slowly pushes in on the peaceful man sleeping calmly at the stern of the violently rocking boat. 3-6s: Water splashes nearby but his face remains tranquil and peaceful. 6-8s: Disciples frantically rush toward him in panic.
  ```
- **Lời dẫn thuyết minh (Narrator Text tiếng Việt):**
  ```text
  Giữa cơn bão kinh hoàng, Chúa vẫn nằm ngủ bình yên nơi đuôi thuyền. Một sự bình an vượt trên mọi nỗi sợ hãi trần gian.
  ```

---

### Phân cảnh 3: Nỗi sợ của môn đệ
- **Thời lượng:** 8 giây
- **Góc máy:** Trung cảnh (*Medium shot*)
- **Prompt hình ảnh (Scene Prompt):**
  ```text
  Terrified ancient fishermen in soaked garments shouting in desperation on the storm-tossed boat, water filling the deck, dramatic lightning illuminating their panic-stricken faces, cinematic emotional atmosphere.
  ```
- **Prompt video (Veo Video Prompt):**
  ```text
  0-3s: The frightened fishermen struggle with the boat oars in pouring rain. 3-6s: One disciple desperately shakes the resting teacher to wake him up. 6-8s: Disciples cry out in anguish as cold sea water floods the deck.
  ```
- **Lời dẫn thuyết minh (Narrator Text tiếng Việt):**
  ```text
  Quá hoảng loạn, các môn đệ chạy đến đánh thức Ngài và kêu lên: "Thầy ơi, chúng ta chết mất mà Thầy không lo sao?"
  ```

---

### Phân cảnh 4: Lời phán uy quyền của Đấng Tối Cao (Cao trào)
- **Thời lượng:** 8 giây
- **Góc máy:** Quay góc thấp từ dưới lên đầy uy nghi (*Low-angle heroic cinematic shot*)
- **Nhân vật:** Chọn `Dang Cuu The`
- **Prompt hình ảnh (Scene Prompt):**
  ```text
  The majestic man stands tall and steadfast at the bow of the tossing boat, robe billowing in the tempest wind, raising his right hand commandingly toward the raging sea and dark sky, golden divine light radiating from him, majestic authority, cinematic masterpiece.
  ```
- **Prompt video (Veo Video Prompt):**
  ```text
  0-3s: The man rises calmly and steps forward to the edge of the boat, unaffected by the shaking. 3-6s: He commands the raging winds, stretching out his hand toward the storm with divine authority. 6-8s: The ferocious winds begin to halt as a golden radiant light pierces through the darkness.
  ```
- **Lời dẫn thuyết minh (Narrator Text tiếng Việt):**
  ```text
  Ngài thức dậy, đứng lên giữa gió gào sóng thét, giơ tay phán bảo cùng bão tố: "Hãy im đi! Hãy lặng đi!"
  ```

---

### Phân cảnh 5: Biển lặng như gương & Thông điệp đức tin (Kết)
- **Thời lượng:** 8 giây
- **Góc máy:** Toàn cảnh hùng vĩ (*Epic panoramic shot*)
- **Nhân vật:** Chọn `Dang Cuu The`
- **Prompt hình ảnh (Scene Prompt):**
  ```text
  Immediately the storm vanishes, the sea becomes completely calm like a polished mirror, magnificent golden dawn breaking through parting clouds, warm heavenly rays illuminating the boat and peaceful ocean, breathtaking serenity, heavenly atmosphere, 8k.
  ```
- **Prompt video (Veo Video Prompt):**
  ```text
  0-3s: The fierce waves instantly subside into glassy calm water. 3-6s: Golden sunlight breaks through the storm clouds, illuminating the ocean with breathtaking warmth. 6-8s: The man turns gently to his disciples with loving compassion as peace fills the atmosphere.
  ```
- **Lời dẫn thuyết minh (Narrator Text tiếng Việt):**
  ```text
  Lập tức gió liền tắt, và biển lặng như tờ. Trong giông bão cuộc đời, chỉ cần bạn tin cậy và có Chúa ở cùng, mọi sóng gió đều sẽ bình yên.
  ```

---

## 🚀 BƯỚC 4: SINH VIDEO & HOÀN THIỆN (POST-PRODUCTION)

1. **Tạo ảnh & Video tự động:**
   - Trong tab **Videos** -> Bấm **Generate Images** (Hệ thống tự động tạo 5 ảnh phân cảnh qua Google Flow).
   - Sau khi ảnh hoàn tất -> Bấm **Generate Videos** (Google Veo sẽ tạo 5 clip video 8s chuyển động mượt mà).
2. **Tạo giọng đọc (TTS):**
   - Vào tab **Post-Production** -> Mục **Narration/TTS**.
   - Chọn công cụ: `VieNeu-TTS` hoặc `Edge-TTS` (chọn giọng đọc nam truyền cảm như `vi-VN-NamMinhNeural` hoặc giọng nữ sâu lắng `vi-VN-HoaiMyNeural`).
   - Bấm **Generate Audio** cho toàn bộ kịch bản.
3. **Ghép & Khớp thời lượng tự động:**
   - Sử dụng lệnh hoặc nút xuất video `/fk-concat-fit-narrator`.
   - Hệ thống tự động cắt các clip khớp khít theo từng câu thoại tiếng Việt, chèn phụ đề chữ nổi đẹp mắt và lồng nhạc nền giao hưởng nhẹ nhàng.
4. **Tải thành phẩm:**
   - Tải file `.mp4` hoàn chỉnh đã được căn chỉnh 1080x1920 sẵn sàng đăng Facebook Reels, TikTok hoặc YouTube Shorts!
