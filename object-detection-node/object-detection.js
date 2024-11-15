module.exports = function (RED) {
  const { YOLO_CLASSES } = require("./constants");

  const mapping = new Map();

  for (let i = 0; i < YOLO_CLASSES.length; i++) {
    mapping.set(YOLO_CLASSES[i], i);
  }

  function yolov8Node(config) {
    RED.nodes.createNode(this, config);

    const ort = require("onnxruntime-node");
    const sharp = require("sharp");
    const fs = require("fs");

    const node = this;
    const returnValue = Number(config.returnValue);
    const saveDir = config.absolutePathDir;

    let model;

    node.on("input", async function (msg) {
      this.status({ fill: "blue", shape: "dot", text: "processing..." });

      try {
        if (model === undefined) {
          const sessionOption = { executionProviders: [config.ep] };
          model = await ort.InferenceSession.create(
            `${__dirname}/../model/${config.model}.onnx`,
            sessionOption
          );
        }

        if (returnValue === 3 && fs.existsSync(saveDir) === false) {
          this.status({
            fill: "red",
            shape: "ring",
            text: "folder dosen't exists",
          });
          node.error("folder dosen't exists");
          return;
        }

        const bufferFromImage = msg.payload;
        const img = sharp(bufferFromImage);
        const boxes = await detectObjectsOnImage(img);
        msg.payload = {};
        msg.payload.originImg = bufferFromImage;
        if (returnValue === 0) {
          msg.payload.data = getDetectedObjects(boxes);
        } else if (returnValue === 1) {
            msg.payload.data = await getDrawImageBuffers(boxes, bufferFromImage);
        } else if (returnValue === 2) {
            msg.payload.data = await getImageBuffers(boxes, bufferFromImage);
        } else if (returnValue === 3) {
          let objectsCount = Array(80)
            .fill()
            .map(() => 0);

          msg.payload.data = await saveImages(
            boxes,
            objectsCount,
            bufferFromImage
          );
        }

        node.send(msg);
        this.status({});
      } catch (error) {
        this.status({ fill: "red", shape: "ring", text: error });
        node.log(error);
      }
    });

    async function detectObjectsOnImage(img) {
      const [input, imgWidth, imgHeight] = await prepareInput(img);
      const output = await runModel(input);
      return processOutput(output, imgWidth, imgHeight);
    }

    async function prepareInput(img) {
      const md = await img.metadata();

      const [imgWidth, imgHeight] = [md.width, md.height];
      const pixels = await img
        .removeAlpha()
        .resize({ width: 640, height: 640, fit: "fill" })
        .raw()
        .toBuffer();

      const red = [];
      const green = [];
      const blue = [];

      for (let index = 0; index < pixels.length; index += 3) {
        red.push(pixels[index] / 255.0);
        green.push(pixels[index + 1] / 255.0);
        blue.push(pixels[index + 2] / 255.0);
      }

      const input = [...red, ...green, ...blue];

      return [input, imgWidth, imgHeight];
    }

    async function runModel(input) {
      input = new ort.Tensor(Float32Array.from(input), [1, 3, 640, 640]);
      const outputs = await model.run({ images: input });
      return outputs["output0"].data;
    }

    function processOutput(output, imgWidth, imgHeight) {
      let boxes = [];
      for (let index = 0; index < 8400; index++) {
        const [classId, prob] = [...Array(80).keys()]
          .map((col) => [col, output[8400 * (col + 4) + index]])
          .reduce((accum, item) => (item[1] > accum[1] ? item : accum), [0, 0]);
        if (prob < config.threshold) {
          continue;
        }
        const label = YOLO_CLASSES[classId];
        const xc = output[index];
        const yc = output[8400 + index];
        const w = output[2 * 8400 + index];
        const h = output[3 * 8400 + index];

        const x1 = ((xc - w / 2) / 640) * imgWidth;
        const y1 = ((yc - h / 2) / 640) * imgHeight;
        const x2 = ((xc + w / 2) / 640) * imgWidth;
        const y2 = ((yc + h / 2) / 640) * imgHeight;
        boxes.push([x1, y1, x2, y2, label, prob]);
      }

      boxes = boxes.sort((box1, box2) => box2[5] - box1[5]);
      let result = [];
      while (boxes.length > 0) {
        result.push(boxes[0]);
        boxes = boxes.filter((box) => iou(boxes[0], box) < 0.7);
      }
      return result;
    }

    function getDetectedObjects(boxes) {
      const result = {};
      boxes.forEach((box) => {
        const info = {
          x: box[0],
          y: box[1],
          w: box[2] - box[0],
          h: box[3] - box[1],
          prob: box[5],
        };

        if (result.hasOwnProperty(box[4]) === false) {
          result[box[4]] = [];
        }
        result[box[4]].push(info);
      });
      return result;
    }

    async function getImageBuffers(boxes, bufferFromImage) {
      const result = {};
      await Promise.all(
        boxes.map(async (box) => {
          try {
            const buffer = await makeBuffer(box, bufferFromImage);
            if (result.hasOwnProperty(box[4]) === false) {
              result[box[4]] = [];
            }
            result[box[4]].push(buffer);
          } catch (error) {
            node.error("An error occured, when image cropped");
          }
        })
      );
      return result;
    }

      async function getDrawImageBuffers(boxes, bufferFromImage) {
          const result = {};
          const svgArray = [];
          boxes.forEach((box) => {
              const svgBuffer = Buffer.from(
                  `<svg><rect width="${parseInt((box[2] - box[0] - 5))}" height="${parseInt((box[3] - box[1] - 5))}" stroke="red" stroke-width="5" fill="none"/><text x="5" y="15" fill="red" font-size="15">${box[4]} ${(box[5]).toFixed(2)}</text></svg>`
              );
              svgArray.push({ input: svgBuffer, top: parseInt(box[1]), left: parseInt(box[0]), blend: 'over' });
          });

          const buffer = await sharp(bufferFromImage)
              .composite(svgArray)
              .toFormat("png")
              .toBuffer();
          return buffer;
      }

    async function saveImages(boxes, objectsCount, bufferFromImage) {
      const today = new Date();
      const dateformat =
        today.getFullYear() +
        (today.getMonth() + 1 < 10
          ? "0" + (today.getMonth() + 1)
          : today.getMonth() + 1) +
        (today.getDate() < 10 ? "0" + today.getDate() : today.getDate()) +
        (today.getHours() < 10 ? "0" + today.getHours() : today.getHours()) +
        (today.getMinutes() < 10
          ? "0" + today.getMinutes()
          : today.getMinutes()) +
        (today.getSeconds() < 10
          ? "0" + today.getSeconds()
          : today.getSeconds());

      const result = {};
      await Promise.all(
        boxes.map(async (box) => {
          const label = box[4];
          if (result.hasOwnProperty(label) === false) {
            result[label] = [];
          }

          const imageName =
            dateformat +
            "_" +
            label +
            ++objectsCount[mapping.get(label)] +
            ".png";
          const outputImage = saveDir + "/" + imageName;
          await sharp(bufferFromImage)
            .extract({
              width: parseInt(box[2] - box[0]),
              height: parseInt(box[3] - box[1]),
              left: parseInt(box[0]),
              top: parseInt(box[1]),
            })
            .toFile(outputImage)
            .then(() => result[label].push(imageName))
            .catch(() =>
              node.error("An error occured, when image cropped and saved")
            );
        })
      );

      for (let key in result) {
        result[key].sort((name1, name2) => {
          return name1.length - name2.length || name1.localeCompare(name2);
        });
      }
      return result;
    }

    async function makeBuffer(box, bufferFromImage) {
      const buffer = await sharp(bufferFromImage)
        .extract({
          width: parseInt(box[2] - box[0]),
          height: parseInt(box[3] - box[1]),
          left: parseInt(box[0]),
          top: parseInt(box[1]),
        })
        .toFormat("png")
        .toBuffer();

      return buffer;
    }

    function iou(box1, box2) {
      return intersection(box1, box2) / union(box1, box2);
    }

    function union(box1, box2) {
      const [box1_x1, box1_y1, box1_x2, box1_y2] = box1;
      const [box2_x1, box2_y1, box2_x2, box2_y2] = box2;
      const box1_area = (box1_x2 - box1_x1) * (box1_y2 - box1_y1);
      const box2_area = (box2_x2 - box2_x1) * (box2_y2 - box2_y1);
      return box1_area + box2_area - intersection(box1, box2);
    }

    function intersection(box1, box2) {
      const [box1_x1, box1_y1, box1_x2, box1_y2] = box1;
      const [box2_x1, box2_y1, box2_x2, box2_y2] = box2;
      const x1 = Math.max(box1_x1, box2_x1);
      const y1 = Math.max(box1_y1, box2_y1);
      const x2 = Math.min(box1_x2, box2_x2);
      const y2 = Math.min(box1_y2, box2_y2);
      return (x2 - x1) * (y2 - y1);
    }
  }

  RED.nodes.registerType("good-object-detection", yolov8Node);
};
