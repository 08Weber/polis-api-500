async function getData () {
    return await (await fetch("https://polisen.se/api/events")).json()
}

function appendTh (textContent) {
    const thElem = document.createElement("th");
    thElem.className = "th"
    thElem.textContent = textContent;
    document.getElementById("thead").appendChild(thElem)
}

function appendTr () {
    const trElem = document.createElement("tr");
    return document.getElementById("tbody").appendChild(trElem)
}

function appendTd (trElem, textContent) {
    const tdElem = document.createElement("td");
    tdElem.textContent = textContent;
    tdElem.className = "td"
    trElem.appendChild(tdElem)
}

function createTable(data) {

    Object.keys(data[0]).forEach((keys) =>{
        appendTh(keys)
    })

    data.forEach(row => {
        const trElem = appendTr();
        Object.entries(row).forEach(column => {
            appendTd(trElem, column)
        })
    })
}

async function getPosts () {
    const data = await getData()
    createTable(data)
}

getPosts()