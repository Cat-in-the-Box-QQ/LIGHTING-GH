// inline-member-editor.js - ฟอร์มแก้ไขสิทธิ์ทีมงาน (ใช้ใน modal ของหน้า admin)
//
// ไม่มีฟอร์ม "เพิ่มทีมงาน" โดยจงใจ — บัญชี login สร้างจากเบราว์เซอร์ไม่ได้
// (publishable key เรียก auth.admin.createUser() ไม่ได้ และอ่าน auth.users ไม่ได้)
// trigger handle_new_auth_user ใน Supabase จะสร้างแถว members ให้อัตโนมัติ
// เป็น crew + active=true (ใช้งานได้ทันที ไม่มีขั้นอนุมัติ — ดู
// supabase/migration-2026-11-13b-no-approval.sql) งานของหน้านี้คือ "ตั้งสิทธิ์" เท่านั้น
//
// ไม่มีปุ่มลบ — การนำคนออกใช้ปิดใช้งาน (active=false) ซึ่งกดคืนได้ทันที

if (typeof editorEscape === 'undefined') {
  function editorEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

function memberEditorHtml(member = {}, formId = 'memberEditorForm', options = {}) {
  const m = member || {};
  const title = options.title || 'แก้ไขทีมงานและสิทธิ์';
  const submitLabel = options.submitLabel || 'บันทึก';
  const isAdmin = m.role === 'admin';
  const activeId = `${formId}-active`;

  return `
    <div class="editor-form-shell print-hidden">
      <h5 class="mb-3">${editorEscape(title)}</h5>
      <form id="${formId}">
        <div class="row g-3">
          <div class="col-md-4">
            <label class="form-label small mb-0">รหัสประจำตัว</label>
            <input class="form-control" name="code" value="${editorEscape(m.code)}" required>
            <div class="small text-muted mt-1">ห้ามเว้นว่าง และห้ามซ้ำกับคนอื่น</div>
          </div>
          <div class="col-md-8">
            <label class="form-label small mb-0">ชื่อ-นามสกุล</label>
            <input class="form-control" name="fullName" value="${editorEscape(m.fullName)}">
          </div>

          <div class="col-md-12">
            <label class="form-label small mb-0">อีเมลบัญชี</label>
            <input class="form-control" value="${editorEscape(m.email || '(ยังไม่ผูกบัญชี)')}" readonly>
            <div class="small text-muted mt-1">
              อ่านอย่างเดียว — ค่านี้คือสำเนาที่ trigger คัดมาจากบัญชีจริง
              ถ้าจะแก้อีเมลต้องไปแก้ที่ Supabase → Authentication → Users
            </div>
          </div>

          <div class="col-md-4">
            <label class="form-label small mb-0">เบอร์โทร</label>
            <input class="form-control" name="phone" value="${editorEscape(m.phone)}">
          </div>
          <div class="col-md-4">
            <label class="form-label small mb-0">สิทธิ์</label>
            <select class="form-select" name="role">
              <option value="crew"${isAdmin ? '' : ' selected'}>crew — จองได้อย่างเดียว</option>
              <option value="admin"${isAdmin ? ' selected' : ''}>admin — แก้ไขข้อมูลได้</option>
            </select>
          </div>
          <div class="col-md-4 d-flex align-items-end">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" id="${activeId}" name="active"${m.active ? ' checked' : ''}>
              <label class="form-check-label small" for="${activeId}">เปิดใช้งาน (ให้ login ได้)</label>
            </div>
          </div>

          <div class="col-md-12">
            <label class="form-label small mb-0">หมายเหตุ</label>
            <input class="form-control" name="note" value="${editorEscape(m.note)}" placeholder="เช่น ตำแหน่ง / ทีม / หมายเหตุภายใน">
          </div>
        </div>

        <div class="alert alert-warning small mt-3 mb-0">
          <strong>admin</strong> แก้ไข/ซ่อน/ลบอุปกรณ์ได้ทั้งร้าน ให้เฉพาะคนที่ดูแลข้อมูลจริง
          <br>และระบบจะ<strong>ปฏิเสธ</strong>การลดสิทธิ์หรือปิดใช้งาน admin คนสุดท้าย
          กันไม่ให้ทุกคนถูกล็อกออกถาวร
        </div>

        <div class="d-flex gap-2 flex-wrap mt-3 align-items-center">
          <button class="btn btn-dark btn-sm" type="submit">${editorEscape(submitLabel)}</button>
          <button class="btn btn-outline-secondary btn-sm" type="button" id="${formId}-cancel">ปิด</button>
          <span id="${formId}-status" class="small text-success"></span>
        </div>
      </form>
    </div>`;
}

function bindMemberEditor(formId, memberId, onSaved, options = {}) {
  const form = document.getElementById(formId);
  const status = document.getElementById(`${formId}-status`);
  const cancelBtn = document.getElementById(`${formId}-cancel`);
  if (!form) return null;

  function fail(message) {
    if (!status) return;
    status.className = 'small text-danger';
    status.textContent = message;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const current = MemberStore.getById(memberId);
    if (!current) {
      fail('ไม่พบสมาชิกรายนี้ — กด "ตรวจซ้ำ" แล้วลองใหม่');
      return;
    }

    const code = form.elements.code.value.trim();
    if (!code) {
      fail('รหัสประจำตัวห้ามเว้นว่าง');
      return;
    }

    const dup = MemberStore.getAll().find(
      (m) => String(m.id) !== String(memberId)
        && String(m.code || '').trim().toLowerCase() === code.toLowerCase()
    );
    if (dup) {
      fail(`รหัส "${code}" ถูกใช้แล้วโดย ${dup.fullName || dup.email || 'สมาชิกรายอื่น'}`);
      return;
    }

    const patch = {
      code,
      fullName: form.elements.fullName.value.trim(),
      phone: form.elements.phone.value.trim(),
      note: form.elements.note.value.trim(),
      role: form.elements.role.value === 'admin' ? 'admin' : 'crew',
      active: form.elements.active.checked === true,
    };

    // เตือนล่วงหน้าก่อนลดสิทธิ์/ปิดใช้งานบัญชีของตัวเอง
    // trigger protect_last_admin ในฐานข้อมูลเป็นตัวตัดสินจริง (ข้ามไม่ได้)
    // แต่บอกผู้ใช้ก่อนดีกว่าให้กดบันทึกแล้วเจอ error เอา
    const losingAdmin = current.role === 'admin' && current.active === true
      && (patch.role !== 'admin' || patch.active !== true);
    const myEmail = (typeof AdminAuth !== 'undefined' && AdminAuth.getEmail()) || '';
    const isSelf = !!myEmail
      && String(current.email || '').trim().toLowerCase() === myEmail.trim().toLowerCase();

    if (losingAdmin) {
      const who = isSelf ? 'บัญชีของคุณเอง' : `${current.fullName || current.code}`;
      const ok = window.confirm(
        `กำลังจะลดสิทธิ์หรือปิดใช้งาน ${who}\n\n`
        + 'ถ้าเหลือ admin ที่ใช้งานอยู่อีก ระบบจะบันทึกให้\n'
        + 'แต่ถ้าเป็นคนสุดท้าย ฐานข้อมูลจะปฏิเสธเพื่อไม่ให้ทุกคนถูกล็อกออก\n\n'
        + 'ต้องการทำต่อหรือไม่?'
      );
      if (!ok) return;
    }

    try {
      const saved = await MemberStore.update(memberId, patch);
      if (!saved) {
        fail('บันทึกไม่สำเร็จ — ไม่พบแถวนี้ในฐานข้อมูล');
        return;
      }
      if (status) {
        status.className = 'small text-success';
        status.textContent = 'บันทึกแล้ว';
      }
      if (typeof onSaved === 'function') onSaved({ action: 'saved', item: saved });
    } catch (err) {
      console.error('บันทึกสมาชิกไม่สำเร็จ:', err);
      // ข้อความจาก trigger protect_last_admin เป็นภาษาไทยอยู่แล้ว โชว์ตามนั้นได้
      fail((err && err.message) || 'บันทึกไม่สำเร็จ');
    }
  });

  cancelBtn?.addEventListener('click', () => {
    if (typeof options.onCancel === 'function') options.onCancel();
  });

  return {
    close() {
      if (typeof options.onCancel === 'function') options.onCancel();
    },
  };
}
