class Attendee {
    constructor(first_name, last_name, email, role) {
        this.first_name = first_name;
        this.last_name = last_name;
        this.email = email;
        this.role = role;
    }
}
/**
 * @returns {Attendee[]} List of all attendees (including host and co-hosts)
 */
const get_all_attendees = () => {
    // TODO: Get attendee name, email, and role
}
const display_attendees = () => {
    const attendees = get_all_attendees();
    attendees.forEach(attendee => {
        const table = document.getElementById("attendee_table");
        const row = document.createElement("tr");

        // Info
        const info_td = document.createElement("td");
        const info = `
            ${attendee.first_name} ${attendee.last_name}<br />
            ${attendee.email}
        `;
        info_td.appendChild(info);

        // Role dropdown
        const roles = ["Host", "Co-Host", "Invitee"];
        const role_td = document.createElement("td");
        const role_select = document.createElement("select");
        roles.forEach(role => {
            const option = document.createElement("option");
            option.value = role;
            option.text = role;
            if (role === attendee.role) {
                option.selected = true;
            }
            role_select.appendChild(option);
        });
        role_td.appendChild(role_select);

        // Edit button
        const edit_td = document.createElement("td");
        const edit_btn = document.createElement("button");
        edit_btn.innerText = "Edit";
        edit_td.appendChild(edit_btn);

        // Message button
        const message_td = document.createElement("td");
        const message_btn = document.createElement("button");
        message_btn.innerText = "Message";
        message_td.appendChild(message_btn);

        // Delete button
        const delete_td = document.createElement("td");
        const delete_btn = document.createElement("button");
        delete_btn.innerText = "Delete";
        delete_td.appendChild(delete_btn);

        row.appendChild(info_td);
        row.appendChild(role_td);
        row.appendChild(edit_td);
        row.appendChild(message_td);
        row.appendChild(delete_td);

        table.appendChild(row);
    });
}

/* EVENT LISTENERS */
/* Upload Image */
const img_container = document.getElementById("image_container");
const img = document.getElementById("image");
const img_file_input = document.getElementById("image_file_input");

img_container.addEventListener("click", () => {
    console.log("Image container clicked");
    img_file_input.click();
});
img_file_input.addEventListener("change", (evt) => {
    try {
        const file = evt.target.files[0];
        if (file) {
            // TODO: Format and display image
        }
    } catch (error) {
        console.error("Error uploading image:", error);
        return;
    }
});

/* TODO: Delete Talk */
const delete_talk_btn = document.getElementById("delete_talk");

/* Copy Talk (URL) */
const copy_talk_btn = document.getElementById("copy_talk");
const copy_popup = document.getElementById("url_copied");

copy_talk_btn.addEventListener("click", () => {
    url = window.location.href;
    navigator.clipboard.writeText(url);
    // Display popup
    copy_popup.style.display = "block";
    setTimeout(() => copy_popup.style.display = "none", 2000);  // disappear after 2 seconds
});

/* Save Talk Info (Title and description) */
const save_talk_btn = document.getElementById("save_talk_info");

save_talk_btn.addEventListener("click", (evt) => {
    evt.preventDefault();
    console.log("Save talk button pushed");

    const form = document.getElementById("talk_info_form");
    const form_data = new FormData(form);

    // TODO: Send form data to backend
    console.log(`Sending ${form_data}`);
});

/* Add Co-Hosts */
add_co_host_btn = document.getElementById("add_co_host");

add_co_host_btn.addEventListener("click", (evt) => {
    evt.preventDefault();
    console.log("Add co-host(s) button pushed");

    const form = document.getElementById("co_host_form");
    const form_data = new FormData(form);
    const email_str = form_data.get("co_host");
    let emails = [];
    try {
        emails = email_str.replaceAll(" ", "").split(",");
    } catch (error) {
        console.log("Can't get emails from form data");
        return;
    }

    // TODO: Send form data to backend
    console.log(`Adding co-hosts: ${emails}`);
});

document.addEventListener("load", () => {
    // TODO: Load talk, co-host, and attendant info, if exists
});