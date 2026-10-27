# Hướng dẫn cài đặt BIMLynx bản self-host

BIMLynx kết nối Claude Desktop với các project Autodesk Construction Cloud (ACC / Forma) của bạn.
**Bản self-host** chạy hoàn toàn trên máy của bạn, dùng một app Autodesk do chính tổ chức bạn tạo
trong tài khoản Autodesk của mình. Từ đó có hai hệ quả:

- **Lượng dùng API được tính vào tài khoản Autodesk của tổ chức bạn**, không phải của chúng tôi.
  Autodesk tính phí AEC Data Model API theo lượng dữ liệu đọc ra. Capacity đi kèm subscription chỉ
  áp dụng cho app được tạo trong cùng team Autodesk với subscription đó. Phần A hướng dẫn việc này.
- **Dữ liệu project chỉ đi giữa máy bạn và Autodesk.** BIMLynx không có server nào ở giữa.

> Bản tiếng Anh: [SELF-HOST-GUIDE.md](SELF-HOST-GUIDE.md)

## Ai làm gì

| Phần | Ai | Thời gian | Khi nào |
|---|---|---|---|
| [A](#phần-a--team-admin-autodesk-một-lần) | **Team admin** Autodesk | ~10 phút | một lần cho cả tổ chức |
| [B](#phần-b--người-dùng-mỗi-máy) | **Người dùng** | ~5 phút | trên mỗi máy |
| [C](#phần-c--acc-account-admin-và-project-admin) | **ACC account admin** + **project admin** | ~5 phút | sau Phần B, mỗi project một lần |
| [D](#phần-d--kiểm-tra-và-xử-lý-sự-cố) | Bất kỳ ai | — | khi thử nghiệm hoặc khi có lỗi |

Làm **đúng thứ tự này**. Ở Phần C, ACC gắn integration với robot account được tạo ở Phần B. Nếu
lúc thêm integration chưa có robot nào, ACC sẽ cấp cho integration quyền ngang account admin.

Bạn **không** cần cài Node.js, không cần mở terminal, không phải sửa file cấu hình nào.

---

## Phần A — Team admin Autodesk (một lần)

### A1. Dùng team đang giữ subscription

Autodesk chỉ áp capacity API đi kèm subscription cho các app được tạo **trong cùng team với
subscription**. Ví dụ, subscription Forma Build có kèm capacity AEC Data Model mỗi tháng. App tạo ở
nơi khác chỉ có mức free hằng tháng.

1. Đăng nhập [Autodesk Account](https://manage.autodesk.com) với quyền team admin của team đang giữ
   subscription.
2. Vào **Products and Services → Hubs**.
3. Nếu team đó đã có hub loại **Autodesk Platform Services**, dùng hub đó và chuyển sang A2.
4. Nếu chưa có, bấm **Create hub**, chọn product **Autodesk Platform Services**, đặt tên, rồi bấm
   **Create & Activate**.

> Theo Autodesk, cần có APS subscription mới tạo hoặc tham gia được developer hub, và hub đã tạo thì
> không đổi team được. Nếu team của bạn không có nút **Create hub**, hãy liên hệ đại diện Autodesk
> trước khi làm tiếp. Không có hub trong team của subscription thì lượng dùng chỉ được tính vào mức
> free.

### A2. Tạo app

1. Trong developer hub, mở **Applications → Create application**.
2. Đặt tên `BIMLynx` (tên nào cũng được).
3. Application type: **Server-to-Server**. BIMLynx xác thực bằng robot account (Secure Service
   Account), và Autodesk yêu cầu loại app này cho robot account.
4. Phần API access, bật tối thiểu: **Data Management API**, **Model Derivative API**,
   **AEC Data Model API**, **Autodesk Construction Cloud API**. Tên trên portal có thể hơi khác.
5. Bấm **Create**. Sau đó copy **Client ID** và **Client Secret**, gửi cho người dùng qua kênh bảo
   mật như password manager, không gửi qua email hay chat thường.

---

## Phần B — Người dùng (mỗi máy)

Cần Claude Desktop cho Windows hoặc macOS.

1. Tải file `bimlynx-local-<version>.mcpb` theo link chúng tôi gửi.
2. Bấm đúp vào file, hoặc kéo nó vào **Claude Desktop → Settings → Extensions**. Claude Desktop sẽ
   báo publisher chưa được xác minh, vì bundle chưa ký số. Chọn **Install**.
3. Điền các ô cấu hình:

   | Ô | Giá trị |
   |---|---|
   | APS Client ID | lấy từ Phần A |
   | APS Client Secret | lấy từ Phần A |
   | BIMLynx data folder | giữ mặc định (thư mục `BIMLynx` trong thư mục home) hoặc chọn thư mục khác |
   | APS region | `US`, `EMEA` hoặc `AUS`: nơi đặt tài khoản ACC của bạn (mặc định `US`) |

4. Bật extension. Mở chat mới và gõ: **"set up BIMLynx"**.
   - Claude chạy `setup_status` và hiện một checklist. Mọi mục phải là `[ok]`, trừ mục robot account
     sẽ được tạo ở bước sau.
   - Sau đó Claude gọi `setup_create_robot`, lần đầu ở dạng **xem trước (preview)**. Đọc kỹ rồi
     duyệt.
5. Kết quả hiện email của robot, có dạng
   `bimlynx-<tên-máy>@<...>.adskserviceaccount.autodesk.com`. **Gửi email này cho ACC admin** để
   làm Phần C.
6. **Thoát hẳn Claude Desktop rồi mở lại.** Chỉ đóng cửa sổ là chưa đủ: trên Windows, thoát từ biểu
   tượng ở khay hệ thống; trên macOS, dùng Claude → Quit. Khi mở lại, BIMLynx khởi động với đầy đủ
   tool.

Thư mục dữ liệu lúc này chứa `robot-key.pem` (private key của robot), `robot.json` và audit log.
**Giữ thư mục này riêng tư.** Không chia sẻ, không đặt trong ổ đồng bộ hay ổ dùng chung. Ai có key
này và Client Secret của bạn đều có thể hành động dưới danh nghĩa robot.

---

## Phần C — ACC account admin và project admin

### C1. Thêm custom integration (account admin, một lần)

1. Trong ACC / Forma, mở **Account Admin → Custom Integrations**.
2. Thêm một custom integration: nhập **Client ID** từ Phần A, kèm tên (ví dụ BIMLynx) và mô tả.
3. ACC tự nhận ra robot account đã tạo ở Phần B và gắn integration với robot đó.

### C2. Mời robot vào project (project admin, mỗi project)

1. Mở project → **Project Admin → Members → Add members**.
2. Nhập **email robot** từ bước B5.
3. Cấp quyền **Docs**. Thêm **Model Coordination** nếu dùng tool clash. Ở trang Members, kiểm tra
   robot đã được gán các module Build sẽ dùng, như Issues và Reviews.
4. Cấp **quyền folder** và **quyền Issues** như cấp cho một người dùng. Robot chỉ thấy đúng những gì
   được cấp, không hơn.

BIMLynx chỉ truy cập được những project mà robot là thành viên.

---

## Phần D — Kiểm tra và xử lý sự cố

### Thử lần đầu

Trong chat mới, hỏi: **"List my ACC hubs and projects."** Sau đó thử một thao tác chỉ đọc trên một
project, ví dụ "List the open issues in project X".

Mọi thao tác **ghi** (tạo issue, thêm comment, tạo review, ...) đều hiện preview trước và chỉ chạy
sau khi bạn duyệt. Mỗi lần gọi được ghi vào audit log trong thư mục dữ liệu.

### Lỗi thường gặp

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Đã khởi động lại mà Claude vẫn chỉ có `setup_status` / `setup_create_robot` | Robot chưa được tạo, hoặc đã đổi thư mục dữ liệu | Hỏi "check BIMLynx setup status"; kết quả cho biết còn thiếu gì |
| Setup status: *Client ID / Client Secret rejected* | Sai secret | Copy lại cả hai giá trị (Claude Desktop → Settings → Extensions → BIMLynx) |
| Setup status: *APS does not recognize this Client ID* (AUTH-001) | Sai Client ID, hoặc app chưa có quyền API | Copy lại Client ID; kiểm tra app là loại Server-to-Server (A2) |
| Setup status: *refused to list service accounts* | App không quản lý được service account | Kiểm tra loại app (A2); gửi chúng tôi nguyên văn thông báo |
| Setup status: *all 10 service accounts are used* | Autodesk giới hạn 10 robot cho mỗi app | Xoá robot không dùng, hoặc xin tăng qua APS "Get Help" |
| Setup status: *belongs to a different APS app* | Thư mục dữ liệu từng được dùng với app khác | Chuyển `robot.json` và `robot-key.pem` ra khỏi thư mục, rồi chạy setup lại |
| `Access denied (403)` trên một project | Thiếu custom integration (C1) hoặc chưa mời robot (C2) | Làm C1 / C2 |
| `404 ... no access` ở tool clash (`mc_*`) | Robot chưa có Model Coordination trong project | Thêm product ở C2 |
| Extension không khởi động | — | Xem log BIMLynx của Claude Desktop (Windows: `%APPDATA%\Claude\logs`, macOS: `~/Library/Logs/Claude`) và gửi cho chúng tôi |

### Cài lại từ đầu trên một máy

1. Xoá `robot.json` và `robot-key.pem` trong thư mục dữ liệu.
2. Xoá robot cũ để nó không chiếm một trong 10 suất. Có thể xoá trên APS developer portal, hoặc liên
   hệ chúng tôi để được hướng dẫn.
3. Khởi động lại Claude Desktop và chạy lại "set up BIMLynx".

---

## Kiểm soát chi phí API

Autodesk tính giá API theo từng tổ chức, và giá có thể thay đổi. Xem
[bảng giá APS](https://www.autodesk.com/products/autodesk-platform-services/product-details).
Tại thời điểm viết tài liệu này:

- **AEC Data Model API** (các tool `aecdm_*`, và `issues_pin_element` vì nó đọc vị trí element)
  tính phí theo **lượng dữ liệu đọc ra**. Có một mức free nhỏ mỗi tháng. Capacity kèm subscription
  chỉ áp dụng khi bước A1 được làm trong team của subscription. Một truy vấn lấy mọi element của một
  category trong model lớn có thể vượt 1 MB.
- **Model Derivative API** (các tool `md_*`) có mức free hằng tháng lớn cho các call cơ bản.
  `md_get_properties` với `group_by` / `sum_fields` trả lời được phần lớn câu hỏi về tham số:
  khối lượng theo tầng, diện tích, số lượng.
- Data Management, Issues, Reviews, Model Properties và Webhooks hiện chưa tính phí.

Theo dõi lượng dùng thực tế của từng app trong developer hub: **Applications → app của bạn → API
usage**. Dùng **Hub analytics → Token usage** để xem cho cả hub. Hãy kiểm tra sau vài ngày dùng đầu
tiên để chắc chắn lượng dùng hiện dưới app và team của chính bạn.

## Cái gì chạy ở đâu

- Server là một file JavaScript duy nhất nằm trong extension, chạy bằng Node.js đi kèm Claude
  Desktop.
- Claude Desktop giữ Client Secret (nhập ở ô có che ký tự). Thư mục dữ liệu chứa key của robot và
  audit log. Audit log cũ hơn 90 ngày được tự động xoá.
- Kết nối mạng chỉ đi tới API của Autodesk (`developer.api.autodesk.com`) và các link tải có chữ ký
  do chính các API đó trả về.
- Chính sách quyền riêng tư: [PRIVACY.md](../PRIVACY.md). Hỗ trợ: hello@bimlynx.com
